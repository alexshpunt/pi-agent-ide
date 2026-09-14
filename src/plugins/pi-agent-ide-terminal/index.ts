import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.js";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import { terminalProcessProvider } from "#src/plugins/pi-agent-ide-terminal/src/process-provider.js";
import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.js";
import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";
import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";

/** Register the platform-aware terminal runner and shell session resources. */
export default async function registerTerminal(pi: ExtensionAPI): Promise<void> {
  const manager =
    (takeReloadResource("terminal") as TerminalSessionManager | undefined) ??
    new TerminalSessionManager();
  const profile = resolveShellProfile();
  const ui = new TerminalUi(pi, manager);
  const removeProcessProvider = agentIdeProcessRegistry(pi).add(terminalProcessProvider(manager));

  await Promise.all([registerTerminalResources(pi, manager), registerTerminalSearch(pi, manager)]);
  registerTerminalTools(pi, manager, profile, ui);

  pi.on("session_start", (_event, context) => ui.bind(context));
  pi.on("agent_settled", (_event, context) => ui.onAgentSettled(context));
  pi.on("session_shutdown", async (event) => {
    ui.dispose();
    removeProcessProvider();
    if (event.reason === "reload") {
      retainReloadResource("terminal", manager);
      return;
    }
    forgetReloadResource("terminal", manager);
    await manager.dispose();
  });
}
