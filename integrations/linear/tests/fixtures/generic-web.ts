import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";

/** Own web fixtures before real web reads, but after the Linear resolver. */
export default function genericWeb(pi: ExtensionAPI): void | Promise<void> {
  return connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "generic-web-fixture",
    setup(api) {
      api.addResolver({
        priority: -50,
        resolver: {
          id: "generic-web-fixture",
          async tryResolve(source) {
            if (!source.startsWith("https://")) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "text", text: "Generic web content" }];
                },
              },
            };
          },
        },
      });
    },
  });
}
