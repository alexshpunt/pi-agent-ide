import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation } from "pi-agent-documentation";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";

export const computerSource = "computer:machine/local/windows";
export const computerResult = "SYNTHETIC_COMPUTER_WINDOW";
export const guide = {
  id: "fixture-computer-guide",
  description: "Synthetic computer guide",
  markdown: "SYNTHETIC_COMPUTER_GUIDE",
  triggers: [{ tool: "read", resourcePrefixes: ["computer:"] }],
};

/** A synthetic computer resource for the IDE's Read and progressive guide protocols. */
export default async function registerComputerFixture(pi: ExtensionAPI): Promise<void> {
  connectAgentDocumentation(pi, [guide]);
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "fixture-computer",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "fixture-computer",
          async tryResolve(source) {
            if (source !== computerSource) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: computerResult }];
                },
              },
            };
          },
        },
      });
    },
  });
}
