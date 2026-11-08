import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.ts";
import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.ts";
import { registerTerminalOrigins } from "#src/plugins/pi-agent-ide-terminal/src/origin.ts";

/** Exercise real terminal notices with a short idle interval. */
export default function registerStaleTerminal(pi: ExtensionAPI): void {
  const manager = new TerminalSessionManager();
  const ui = new TerminalUi(pi, manager, 300);
  registerTerminalTools(pi, manager, resolveShellProfile("linux", { SHELL: "/bin/bash" }), ui, undefined, undefined, registerTerminalOrigins(pi));
  pi.on("session_start", (_event, context) => ui.bind(context));
  pi.on("agent_settled", (_event, context) => ui.onAgentSettled(context));
  pi.on("session_shutdown", async () => {
    ui.dispose();
    await manager.dispose();
  });
}
