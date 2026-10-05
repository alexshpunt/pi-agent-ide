import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";

/** Test plugin whose metadata changes after Pi has wrapped the initial tools. */
export default async function readSchemaPlugin(pi: ExtensionAPI): Promise<void> {
  let format = "old-schema-format";
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "schema-lazy",
    setup(api) {
      api.describe({ path: () => format });
    },
  });
  pi.on("session_start", async () => {
    format = "current-schema-format";
    await connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "schema-late",
      setup(api) {
        api.addView({ view: "late-view", presenter: { id: "late-view", present: (document) => document } });
        api.describe({ views: "late-view — a presentation registered at session start." });
      },
    });
  });
}
