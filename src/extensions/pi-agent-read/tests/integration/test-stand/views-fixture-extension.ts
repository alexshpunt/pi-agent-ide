import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEXT = "alpha\nbravo\ncharlie";

/**
 * Registers a text resolver plus two named views so real-Pi runs can exercise
 * opt-in read views: `anchors` prefixes every line, `diagnostics` annotates line 2.
 */
export default async function registerViewsFixture(pi: ExtensionAPI): Promise<void> {
  const plugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "views-fixture",
    setup(api): void {
      api.addResolver({
        resolver: {
          id: "views-fixture",
          async tryResolve(source) {
            if (source !== "views-fixture:notes") {
              return { kind: "not-handled" };
            }

            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: TEXT }];
                },
              },
            };
          },
        },
      });
      api.addView({
        view: "anchors",
        includes: ["lines"],
        presenter: {
          id: "views-fixture-anchor",
          present(document) {
            return {
              ...document,
              lines: document.lines.map((line) => ({
                ...line,
                presentation: {
                  ...line.presentation,
                  prefix: `${String(line.lineNumber).padStart(1)}#hash|${line.presentation?.prefix ?? ""}`,
                },
              })),
            };
          },
        },
      });
      api.addView({
        view: "diagnostics",
        priority: 100,
        presenter: {
          id: "views-fixture-diagnostic",
          present(document) {
            return {
              ...document,
              lines: document.lines.map((line) =>
                line.content === "bravo"
                  ? {
                      ...line,
                      presentation: {
                        ...line.presentation,
                        suffix: `${line.presentation?.suffix ?? ""} <!-- views-fixture: bravo is suspicious -->`,
                      },
                    }
                  : line,
              ),
            };
          },
        },
      });
    },
  } satisfies ReadPlugin;

  await connectReadPlugin(pi, plugin);
}
