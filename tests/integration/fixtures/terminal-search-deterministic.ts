import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.ts";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.ts";

/**
 * Give the shell search regression a stable retained-output address. It registers only the terminal
 * resolver, so a test that depends on resolver order must also load the text-search plugin
 * (`pi-agent-search-text/index.ts`).
 */
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
