import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTerminalResources } from "#src/plugins/pi-agent-ide-terminal/src/resources.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";

export default async function registerDeterministicTerminal(pi: ExtensionAPI): Promise<void> {
  const ids = ["abcdef123456", "abcdef123457"];
  const manager = new TerminalSessionManager(() => ids.shift() ?? "abcdef123458");
  await registerTerminalResources(pi, manager);
  registerTerminalTools(
    pi,
    manager,
    resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    { bind() {} },
  );
  pi.on("session_shutdown", () => manager.dispose());
}
