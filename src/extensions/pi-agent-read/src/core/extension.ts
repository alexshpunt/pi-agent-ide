import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default async function registerReadCore(pi: ExtensionAPI): Promise<void> {
  const core = createReadCore();

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
  pi.registerTool(withToolCallInterceptionRendering(core.read.tool, interceptionRendering));
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
