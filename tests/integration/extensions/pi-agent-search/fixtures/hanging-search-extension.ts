import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerHangingSearch(pi: ExtensionAPI): Promise<void> {
  await connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "hanging-search-fixture",
    setup(api): void {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "hanging",
          tryResolve(request) {
            return request.query === "hang forever"
              ? new Promise<never>(() => {})
              : { kind: "not-handled" };
          },
          format() {
            throw new Error("Hanging resolver must never reach formatting");
          },
        },
      });
    },
  });
}
