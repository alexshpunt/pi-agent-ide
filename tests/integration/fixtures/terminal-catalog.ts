import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTerminalOrigins } from "#src/plugins/pi-agent-ide-terminal/src/origin.ts";
import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.ts";
import { registerTerminalSearch } from "#src/plugins/pi-agent-ide-terminal/src/search.ts";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.ts";

/** Wire the terminal resources, search and tools with Pi-session ownership, as the IDE does. */
export default async function registerTerminalCatalogFixture(pi: ExtensionAPI): Promise<void> {
  const manager = new TerminalSessionManager();
  let sessionId: string | undefined;
  pi.on("session_start", (_event, context) => {
    sessionId = context.sessionManager.getSessionId();
  });
  await Promise.all([
    registerTerminalResources(pi, manager, () => sessionId),
    registerTerminalSearch(pi, manager, () => sessionId),
  ]);
  registerTerminalTools(
    pi,
    manager,
    resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    { bind() {}, notifyWaitTransition() {} },
    "compact",
    undefined,
    registerTerminalOrigins(pi),
  );
  pi.on("session_shutdown", () => manager.dispose());
}
