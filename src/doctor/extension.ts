import {
  DOCTOR_API_VERSION,
  DOCTOR_CORE_READY_EVENT,
  DOCTOR_PLUGIN_REGISTER_EVENT,
  DOCTOR_PROTOCOL,
  isDoctorPluginRegistrationRequest,
} from "#src/api/doctor.js";

import { writeSuggestedConfigs } from "./config-writer.js";
import { DoctorCore } from "./core.js";
import { buildDoctorAgentPrompt, doctorNeedsWork, formatDoctorReport, runDoctor } from "./run.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
Registers the modular doctor core and `/pi-agent-ide-doctor`.
*/
export default async function registerDoctor(pi: ExtensionAPI): Promise<void> {
  const core = new DoctorCore();
  let delegatedProject: string | undefined;
  const unsubscribe = pi.events.on(DOCTOR_PLUGIN_REGISTER_EVENT, (request) => {
    if (!isDoctorPluginRegistrationRequest(request)) {
      throw new Error("Invalid doctor plugin registration request");
    }

    request.accept(core.registerPlugin(request.plugin));
  });
  pi.on("session_shutdown", unsubscribe);

  pi.registerCommand("pi-agent-ide-doctor", {
    description: "Check and configure Pi Agent IDE for this project",
    handler: async (arguments_, context) => {
      await core.waitForPlugins();
      let result = await runDoctor(core.snapshot(), context.cwd);
      sendReport(pi, formatDoctorReport(result));

      const flags = new Set(arguments_.trim().split(/\s+/u).filter(Boolean));
      const shouldApply =
        result.suggestions.length > 0 &&
        !flags.has("--no-apply") &&
        (flags.has("--apply") ||
          (context.hasUI &&
            (await context.ui.confirm(
              "Apply suggested configuration?",
              "Add detected tools to .pi/pi-agent-ide/. Existing entries and native tool settings are kept.",
            ))));

      if (shouldApply) {
        const files = await writeSuggestedConfigs(context.cwd, result.suggestions);
        const updateMessage =
          files.length === 0
            ? "Pi Agent IDE configs are already up to date"
            : `Updated ${files.length} Pi Agent IDE config ${files.length === 1 ? "file" : "files"}`;
        context.ui.notify(updateMessage, "info");
        result = await runDoctor(core.snapshot(), context.cwd);
        sendReport(pi, formatDoctorReport(result));
      }

      if (!doctorNeedsWork(result) && !flags.has("--agent")) {
        return;
      }

      const shouldDelegate =
        flags.has("--agent") ||
        (context.hasUI &&
          (await context.ui.confirm(
            "Ask the agent to finish setup?",
            "The agent will receive this redacted report and relevant plugin recipes.",
          )));

      if (shouldDelegate) {
        delegatedProject = context.cwd;
        pi.sendUserMessage(buildDoctorAgentPrompt(result));
      }
    },
  });

  pi.on("agent_end", async (_event, context) => {
    const cwd = delegatedProject;

    if (cwd === undefined) {
      return;
    }

    delegatedProject = undefined;
    const result = await runDoctor(core.snapshot(), cwd, process.env);
    sendReport(pi, `Doctor recheck after agent setup\n\n${formatDoctorReport(result)}`);

    if (doctorNeedsWork(result)) {
      context.ui.notify("Pi Agent IDE setup still needs attention", "warning");
    } else {
      context.ui.notify("Pi Agent IDE setup is ready", "info");
    }
  });

  pi.events.emit(DOCTOR_CORE_READY_EVENT, {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
  });
  await core.waitForPlugins();
}

function sendReport(pi: ExtensionAPI, content: string): void {
  pi.sendMessage(
    { customType: "pi-agent-ide-doctor", content, display: true },
    { triggerTurn: false },
  );
}
