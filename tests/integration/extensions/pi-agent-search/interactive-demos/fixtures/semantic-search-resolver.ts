import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerSemanticSearchDemo(pi: ExtensionAPI): void | Promise<void> {
  return connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "semantic",
    setup(api): void {
      api.addResolver({
        resolver: {
          id: "semantic",
          tryResolve(request) {
            if (!request.query.startsWith("semantic:")) {
              return Promise.resolve({ kind: "not-handled" });
            }

            return Promise.resolve({
              kind: "resolved",
              payload: {
                query: request.query.slice("semantic:".length).trim(),
              },
            });
          },
          format(payload) {
            if (
              typeof payload !== "object" ||
              payload === null ||
              !("query" in payload) ||
              typeof payload.query !== "string"
            ) {
              throw new Error("Semantic demo payload must contain a query");
            }

            const { query } = payload;
            return {
              content: [
                {
                  type: "text",
                  text: `Search Resolver Corpus\nThe protocol atlas matches ${query}.`,
                },
              ],
              details: { query },
            };
          },
        },
      });
    },
  });
}
