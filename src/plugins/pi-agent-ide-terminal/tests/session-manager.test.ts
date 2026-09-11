import { afterEach, describe, expect, test } from "vitest";

import { renderTerminalScreen } from "#src/plugins/pi-agent-ide-terminal/src/screen-image.js";
import {
  encodeTerminalKeys,
  TerminalSessionManager,
} from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";

const managers: TerminalSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

test("encodes named modifier chords and Unix caret controls", () => {
  expect(encodeTerminalKeys("Ctrl+C ^U Ctrl+Left Ctrl+Shift+Left Alt+Backspace")).toBe(
    "\u0003\u0015\u001b[1;5D\u001b[1;6D\u001b\u007f",
  );
});
describe.runIf(process.platform !== "win32")("terminal session manager", () => {
  test("runs a real command and keeps its final session state", async () => {
    const manager = createManager();
    const session = manager.start({
      command: "printf 'terminal-ok'",
      background: false,
      cwd: process.cwd(),
      shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    });

    await manager.wait(session.source);
    expect(manager.snapshot(session)).toMatchObject({
      source: session.source,
      status: "completed",
      exitCode: 0,
      output: "terminal-ok",
    });
  });

  test("sends text and named keys to an interactive command", async () => {
    const manager = createManager();
    const session = manager.start({
      command: "IFS= read -r answer; printf 'received:%s' \"$answer\"",
      background: true,
      cwd: process.cwd(),
      shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    });

    manager.write(session.source, "hello");
    manager.sendKeys(session.source, "Enter");
    await manager.wait(session.source);

    expect(manager.snapshot(session).output).toContain("received:hello");
  });

  test("centers action previews on the current cursor", async () => {
    const manager = createManager();
    const session = manager.start({
      command: "sleep 30",
      background: true,
      cwd: process.cwd(),
      shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    });
    const previousEnd = session.outputStart + session.output.length;
    const before = manager.screenRows(session);

    manager.write(session.source, "cursor text");
    await manager.waitForOutputAfter(session, previousEnd);

    const preview = manager.screenChangeWindow(session, before, 6).join("\n");
    expect(preview).toContain("cursor text");
    expect(preview).toContain("▌");
  });
  test("renders the virtual terminal screen as a PNG", async () => {
    const manager = createManager();
    const session = manager.start({
      command: "printf '\\033[2J\\033[Hscreen-ok'",
      background: false,
      cwd: process.cwd(),
      shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
    });
    await manager.wait(session.source);

    const image = Buffer.from(await renderTerminalScreen(manager, session.source), "base64");
    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(await manager.screenLines(session.source)).toContain("screen-ok");
  });

  test("deletes one process without affecting another", async () => {
    const manager = createManager();
    const shell = resolveShellProfile("linux", { SHELL: "/bin/bash" });
    const first = manager.start({
      command: "sleep 30",
      background: true,
      cwd: process.cwd(),
      shell,
    });
    const second = manager.start({
      command: "sleep 0.1; printf alive",
      background: true,
      cwd: process.cwd(),
      shell,
    });

    await manager.delete(first.source);
    await manager.wait(second.source);

    expect(manager.get(first.source)).toBeUndefined();
    expect(manager.snapshot(second)).toMatchObject({ status: "completed", output: "alive" });
  });
});

function createManager(): TerminalSessionManager {
  const manager = new TerminalSessionManager();
  managers.push(manager);
  return manager;
}
