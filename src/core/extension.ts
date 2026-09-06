import {
  IDE_API_VERSION,
  IDE_CORE_READY_EVENT,
  IDE_PLUGIN_REGISTER_EVENT,
  IDE_PROTOCOL,
  isIdePluginRegistrationRequest,
} from "#src/api/plugin-protocol.js";
import { createIdeCore } from "#src/core/ide-core.js";
import { runIdePostEditGate } from "#src/post-edit/gate.js";
import { resetRegistry } from "#src/toolchain/registry.js";
import { connectTextEditorPostEditHandler } from "pi-agent-text-editor/api/post-edit";

import path from "node:path";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_PROTOCOL,
  TEXT_EDITOR_API_VERSION,
} from "pi-agent-text-editor/api/plugin-protocol";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function registerPiAgentIde(pi: ExtensionAPI): Promise<void> {
  pi.registerFlag("old-tools", {
    description: "Use the old IDE and text editor tools",
    type: "boolean",
    default: false,
  });
  resetRegistry();
  const core = createIdeCore();
  const unsubscribePlugins = pi.events.on(IDE_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isIdePluginRegistrationRequest(request)) {
      throw new Error("Invalid pi-agent-ide plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", () => {
    unsubscribePlugins();
    core.diagnostics.dispose();
    resetRegistry();
  });
  connectTextEditorPostEditHandler(pi, {
    id: "pi-agent-ide",
    handler: runIdePostEditGate,
  });
  pi.events.emit(IDE_CORE_READY_EVENT, {
    protocol: IDE_PROTOCOL,
    apiVersion: IDE_API_VERSION,
  });

  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "ide-diagnostics",
    setup(api) {
      api.onDidEdit((completion) => {
        if (path.isAbsolute(completion.resourceSource)) {
          core.diagnostics.schedule(completion.resourceSource, completion.after.content, {
            cwd: completion.cwd,
          });
        }
      });
    },
  });
  pi.on("context", async (event, ctx) => {
    const lines = await core.diagnostics.takeNotifications(ctx.cwd);
    if (lines.length === 0) return;
    // Context-only delivery cannot wake an idle agent or create visible transcript rows.
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "ide-diagnostics",
          display: false,
          content: `File diagnostics:\n${lines.join("\n")}`,
          timestamp: Date.now(),
        },
      ],
    };
  });

  await core.waitForPendingPlugins();
}
