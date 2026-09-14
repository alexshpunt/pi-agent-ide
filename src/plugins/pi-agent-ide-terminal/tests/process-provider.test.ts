import { afterEach, expect, test } from "vitest";

import { terminalProcessProvider } from "#src/plugins/pi-agent-ide-terminal/src/process-provider.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";

let manager: TerminalSessionManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

test.runIf(process.platform !== "win32")(
  "forwards process-overlay input to the live terminal",
  async () => {
    manager = new TerminalSessionManager(() => "abcdef123456");
    const session = manager.start({
      command: "IFS= read -r answer; printf 'received:%s' \"$answer\"",
      background: true,
      cwd: process.cwd(),
      shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    });
    const processEntry = terminalProcessProvider(manager).list()[0];
    expect(processEntry?.sendInput).toBeTypeOf("function");

    processEntry?.sendInput?.("from-overlay\r");
    await manager.wait(session.source);

    expect(manager.snapshot(session).output).toContain("received:from-overlay");
  },
);
