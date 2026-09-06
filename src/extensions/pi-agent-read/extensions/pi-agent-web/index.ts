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
        renderContentDescription(
          "Reads HTTP(S) URLs, automatically retrying failed reads or empty HTML in a local browser.",
          readHost.listDescriptions(),
        ),
      );

      api.addPromptGuideline("Use read with the plain HTTP(S) URL; browser fallback is automatic.");
    },
  } satisfies ReadPlugin;

  await Promise.all([
    connectReadPlugin(pi, plugin),
    Promise.resolve(connectDoctorPlugin(pi, webDoctorPlugin)),
  ]);
}
