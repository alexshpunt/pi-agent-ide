import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "#src/composite/extensions-config.js";

import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.js";
import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";
import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";

/** Register the platform-aware terminal runner and shell session resources. */
export default async function registerTerminal(pi: ExtensionAPI): Promise<void> {
  const manager = new TerminalSessionManager();
  const profile = resolveShellProfile();
  const config = await readPiAgentIdeExtensionsConfig(resolvePiAgentIdeExtensionsConfigPaths());
  const activity = terminalActivityMode(config.preferences?.["terminal.activity"]);
  const ui = new TerminalUi(pi, manager, activity);

  await Promise.all([registerTerminalResources(pi, manager), registerTerminalSearch(pi, manager)]);
  registerTerminalTools(pi, manager, profile, ui);

  pi.on("session_start", (_event, context) => ui.bind(context));
  pi.on("session_shutdown", async () => {
    ui.dispose();
    await manager.dispose();
  });
}

function terminalActivityMode(value: string | undefined): "detailed" | "compact" | "off" {
  return value === "compact" || value === "off" ? value : "detailed";
}
