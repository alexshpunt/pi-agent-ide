import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";

import { loadWebsearchConfig } from "#src/config.ts";
import { webSearchDoctorPlugin } from "#src/doctor-plugin.ts";
import {
  createSearchRoutingState,
  formatSearchText,
  performSearch,
  type SearchRoutingState,
} from "#src/search.ts";

import type { SearchDetails } from "#src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SearchResolver } from "pi-agent-search/api/search";

export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  let routingState: SearchRoutingState | undefined;
  let routingKey = "";
  const resolver: SearchResolver = {
    id: "web",
    async tryResolve(request, context) {
      if (!request.query.startsWith("web:")) {
        return { kind: "not-handled" };
      }

      const query = request.query.slice("web:".length).trim();

      if (query.length === 0) {
        return { kind: "failed", error: new Error("web: query must not be empty") };
      }

      const loaded = await loadWebsearchConfig({ cwd: context.cwd });

      if (!loaded.ok) {
        return { kind: "failed", error: new Error(loaded.message) };
      }

      const config = loaded.config;
      const nextKey = `${config.strategy}:${config.providers
        .map((provider) => provider.id ?? provider.provider)
        .join("|")}`;

      if (
        routingState === undefined ||
        routingKey !== nextKey ||
        routingState.successCounts.length !== config.providers.length
      ) {
        routingState = createSearchRoutingState(config.providers.length);
        routingKey = nextKey;
      }

      const maxResults = Math.min(request.limit ?? config.providers[0]?.maxResults ?? 10, 1000);
      const details = await performSearch(
        config,
        { query, maxResults },
        context.signal,
        routingState,
      );
      return { kind: "resolved", payload: details };
    },
    format(payload) {
      const details = payload as SearchDetails;
      return { content: [{ type: "text", text: formatSearchText(details) }], details };
    },
  };
  await Promise.all([
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "web",
      setup(api): void {
        api.addResolver({ resolver });
        api.describe(
          "Use `web:<query>` for current web information. Results include source URLs that can be cited directly.",
        );
      },
    }),
    connectDoctorPlugin(pi, webSearchDoctorPlugin),
  ]);
}
