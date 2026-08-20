import { readFile } from "node:fs/promises";
import path from "node:path";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";

import type { ResourceResolver } from "pi-agent-resource";

export default async function registerOtherTextResolver(pi: ExtensionAPI): Promise<void> {
  const plugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "other-text-resolver",
    setup(api) {
      const resolver = {
        id: "other-text",
        tryResolve(source, context) {
          const prefix = "other:";

          if (!source.startsWith(prefix)) {
            return Promise.resolve({ kind: "not-handled" } as const);
          }

          const file = path.resolve(context.cwd, source.slice(prefix.length));

          return Promise.resolve({
            kind: "resolved",
            resource: {
              source: file,
              async read(operationContext) {
                const text = await readFile(file, {
                  encoding: "utf8",
                  ...(operationContext.signal !== undefined && { signal: operationContext.signal }),
                });
                return [{ type: "text", text }];
              },
            },
          } as const);
        },
      } satisfies ResourceResolver;
      api.addResolver({ resolver, priority: -10 });
      api.describe("Loads text through the integration-test resolver.");
    },
  } satisfies ReadPlugin;

  await connectReadPlugin(pi, plugin);
}
