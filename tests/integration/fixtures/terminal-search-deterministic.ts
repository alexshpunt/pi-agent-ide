import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";

/** Give the shell search regression a stable retained-output address. */
export default async function registerTerminalSearchFixture(pi: ExtensionAPI): Promise<void> {
  const manager = new TerminalSessionManager(() => "abcdef123456");
  await registerTerminalSearch(pi, manager);
  registerTerminalTools(pi, manager, resolveShellProfile("linux", { SHELL: "/bin/bash" }), {
    bind() {},
    notifyWaitTransition() {},
  });
  pi.on("before_agent_start", (_event, ctx) => ctx.ui.setToolsExpanded(false));
  pi.on("session_shutdown", () => manager.dispose());
}
