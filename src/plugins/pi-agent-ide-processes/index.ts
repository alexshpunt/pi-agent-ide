import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.ts";
import { listenPresentationPreference } from "#src/composite/live-presentation.ts";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.ts";
import {
  AgentIdeProcessesUi,
  type ProcessActivityMode,
} from "#src/plugins/pi-agent-ide-processes/src/ui.ts";

/** Register the shared Agent IDE process widget and overlay. */
export default async function registerAgentIdeProcesses(pi: ExtensionAPI): Promise<void> {
  const registry = agentIdeProcessRegistry(pi);
  const config = await readPiAgentIdeExtensionsConfig(resolvePiAgentIdeExtensionsConfigPaths());
  const ui = new AgentIdeProcessesUi(
    registry,
    activityMode(config.preferences?.["processes.activity"]),
    pi,
  );
  listenPresentationPreference(pi, "processes.activity", (value) =>
    ui.setActivityMode(activityMode(value)),
  );
  pi.on("session_start", (_event, context) => ui.bind(context));
  pi.on("session_shutdown", () => ui.dispose());
}

function activityMode(value: string | undefined): ProcessActivityMode {
  return value === "compact" || value === "off" ? value : "detailed";
}
