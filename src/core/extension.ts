import {
  IDE_API_VERSION,
  IDE_CORE_READY_EVENT,
  IDE_PLUGIN_REGISTER_EVENT,
  IDE_PROTOCOL,
  isIdePluginRegistrationRequest,
} from "#src/api/plugin-protocol.js";
import { createIdeCore } from "#src/core/ide-core.js";
import {
  diagnosticEntryData,
  DIAGNOSTIC_ENTRY_TYPE,
  registerDiagnosticEntryRenderer,
} from "#src/core/diagnostic-entry.js";
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
  registerDiagnosticEntryRenderer(pi);
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
    handler: (transaction) =>
      pi.getFlag("pi-agent-ide-no-post-processing") === true
        ? Promise.resolve({ formatting: { status: "disabled" } })
        : runIdePostEditGate(transaction),
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
        if (pi.getFlag("pi-agent-ide-no-post-processing") === true) return;
        if (path.isAbsolute(completion.resourceSource)) {
          core.diagnostics.schedule(completion.resourceSource, completion.after.content, {
            cwd: completion.cwd,
          });
        }
      });
    },
  });
  let delivery = Promise.resolve();
  let closed = false;
  const isClosed = () => closed;
  const unsubscribeDiagnostics = core.diagnostics.onDidChange((cwd) => {
    delivery = delivery
      .then(async () => {
        if (closed) return;
        const notifications = await core.diagnostics.takeNotifications(cwd);
        if (isClosed() || notifications.length === 0) return;
        pi.sendMessage(
          {
            customType: "ide-diagnostics",
            display: false,
            content: `File diagnostics:\n${notifications.map((item) => item.text).join("\n")}`,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        for (const notification of notifications) {
          pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, diagnosticEntryData(notification));
        }
      })
      .catch((error: unknown) => {
        console.error("Diagnostic delivery failed", error);
      });
  });
  pi.on("session_shutdown", () => {
    closed = true;
    unsubscribeDiagnostics();
  });

  await core.waitForPendingPlugins();
}
