import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { type ContentTarget, createContentHost, renderContentDescription } from "pi-agent-resource";

import { webDoctorPlugin } from "#src/doctor-plugin.js";
import { createWebResolver } from "#src/resolver.js";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import {
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchPlugin,
} from "pi-agent-search/api/plugin-protocol";
import { createWebSearchResolver } from "#src/search.js";

const readTarget = { provider: "web", capability: "read" } satisfies ContentTarget;
const renderWebResult = createReadResultRenderer({ kind: "markdown", label: "WEB" });

export default async function registerWeb(pi: ExtensionAPI): Promise<void> {
  const readHost = createContentHost(pi, readTarget);
  const webResolver = createWebResolver(readHost);
  const plugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "web",
    setup(api) {
      api.addResolver({
        resolver: webResolver,
        renderResult: renderWebResult,
        preserveTruncatedOutput: true,
      });
      api.describe(() =>
        renderContentDescription("HTTP(S) URL — remote content.", readHost.listDescriptions()),
      );
    },
  } satisfies ReadPlugin;

  const searchPlugin = {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "web",
    setup(api) {
      // Claim URL scopes before local query resolvers such as regex.
      api.addResolver({ resolver: createWebSearchResolver(webResolver), priority: -100 });
      api.describe(
        "HTTP(S) Search reuses converted page text for zero-result identifier spelling suggestions. Candidate groups carry the URL and line ranges, never editable SEARCH references.",
      );
      api.addPromptGuideline(
        "Use search with an HTTP(S) path to find text on a web page; no prior read is required.",
      );
    },
  } satisfies SearchPlugin;
  await Promise.all([
    connectReadPlugin(pi, plugin),
    connectSearchPlugin(pi, searchPlugin),
    Promise.resolve(connectDoctorPlugin(pi, webDoctorPlugin)),
  ]);
}
