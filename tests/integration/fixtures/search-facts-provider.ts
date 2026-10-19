import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

/** Exercise a real custom resolver without claiming match facts from its private domain value. */
export default async function searchFactsProvider(pi: ExtensionAPI): Promise<void> {
  await connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "search-facts-control",
    setup(api) {
      api.addResolver({
        priority: -100,
        resolver: {
          id: "search-facts-control",
          readResources: () => [],
          async tryResolve(request) {
            if (request.query === "facts:failed")
              return { kind: "failed", error: new Error("Controlled resolver failure") };
            if (request.query !== "facts:custom") return { kind: "not-handled" };
            return { kind: "resolved", payload: {} };
          },
          format: () => ({ content: [{ type: "text", text: "Custom resolver response" }], details: {} }),
          toScriptData: () => ({
            kind: "custom",
            resolverId: "search-facts-control",
            value: { matches: ["private"], complete: true, privateField: "not a public fact" },
          }),
        },
      });
    },
  });
}
