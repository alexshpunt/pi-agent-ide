import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectResultTargets } from "pi-agent-resource";
import { createReadResultTargetHandler } from "#src/core/tools/read/result-target.js";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import {
  ToolCallInterceptionRenderStore,
  withToolCallInterceptionRendering,
} from "pi-agent-tool-call-interception";

import {
  isReadPluginRegistrationRequest,
  READ_API_VERSION,
  READ_CORE_READY_EVENT,
  READ_PLUGIN_REGISTER_EVENT,
  READ_PROTOCOL,
} from "#src/api/plugin-protocol.js";
import { createReadCore } from "#src/core/read-core.js";

import { compactReadDetails } from "#src/core/tools/read/persisted-result.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePresentation(value: string | undefined): "full" | "compact" | "disabled" {
  return value === "full" || value === "disabled" ? value : "compact";
}
export default async function registerReadCore(
  pi: ExtensionAPI,
  context?: { readonly preferences: Readonly<Record<string, string>> },
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "read-resources",
      description: "Read results, selection boundaries, and composition",
      triggers: [{ tool: "read" }],
    }),
  ]);
  const core = createReadCore(parsePresentation(context?.preferences["ui.read"]));
  const targets = connectResultTargets(pi);
  await core.registerPlugin({
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "result-targets",
    setup(api) {
      api.addHandler({ stage: "post-read", handler: createReadResultTargetHandler(targets) });
    },
  });

  const unsubscribeRegistration = pi.events.on(READ_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isReadPluginRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-read plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", async () => {
    unsubscribeRegistration();
    await core.read.dispose();
  });

  const interceptionRendering = new ToolCallInterceptionRenderStore();
  const definition = withToolCallInterceptionRendering(core.read.tool, interceptionRendering);
  pi.registerTool(definition);
  pi.on("before_agent_start", async () => {
    await core.waitForPendingPlugins();
    // Pi snapshots schemas when it wraps definitions. Refresh current plugin metadata for this run.
    if (pi.getActiveTools().includes("read")) pi.registerTool(definition);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !isRecord(event.details)) {
      return;
    }

    return {
      details: compactReadDetails(
        event.details,
        event.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
      ),
      ...(event.details.failure !== undefined && { isError: true }),
    };
  });
  pi.events.emit(READ_CORE_READY_EVENT, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
  });

  await core.waitForPendingPlugins();
}
