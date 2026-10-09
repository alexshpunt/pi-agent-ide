import { readFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { structuredShellResult } from "#src/plugins/pi-agent-ide-terminal/src/shell-result.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";

const managers: TerminalSessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const session of manager.list()) await manager.delete(session.source);
    await manager.dispose();
  }
});

test("keeps shell startup failure as data without inventing an exit code", async () => {
  const manager = new TerminalSessionManager();
  managers.push(manager);
  const session = manager.start({
    command: "unused",
    background: false,
    cwd: process.cwd(),
    shell: {
      executable: "pi-agent-ide-missing-shell-lpt-300",
      displayName: "Missing shell",
      family: "posix",
      commandArgs: () => {
        throw new Error("Shell configuration unavailable");
      },
    },
  });
  const result = await structuredShellResult(manager.snapshot(session));
  expect(result).toMatchObject({ status: "failed", output: "", truncated: false });
  expect(result.error).toBeTruthy();
  expect(result).not.toHaveProperty("exit_code");
});

function start(command: string) {
  const manager = new TerminalSessionManager();
  managers.push(manager);
  const session = manager.start({
    command,
    background: false,
    cwd: process.cwd(),
    shell: resolveShellProfile("linux", { SHELL: "/bin/bash" }),
  });
  return { manager, session };
}

test.runIf(process.platform !== "win32").each([
  ["x", 1024 * 1024],
  ["x", 1024 * 1024 + 1],
  ["€", 400000],
  ["😀", 300000],
] as const)(
  "keeps truthful UTF-8 log ranges for %s repeated %i times",
  async (character, count) => {
    const expected = character.repeat(count);
    const { manager, session } = start(
      `node -e 'process.stdout.write(${JSON.stringify(character)}.repeat(${count}))'`,
    );
    await manager.wait(session.source);
    const result = await structuredShellResult(manager.snapshot(session));
    const log = await readFile(result.full_output_path);
    expect(log.toString("utf8")).toBe(expected);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024 * 1024);
    expect(result.output).not.toContain("�");
    expect(result.truncated).toBe(log.length > 1024 * 1024);
    expect(result.output).toBe(
      result.output_ranges
        .map(({ start, end }) => log.subarray(start, end).toString("utf8"))
        .join(""),
    );
    if (!result.truncated) expect(result.output).toBe(expected);
  },
);

test.runIf(process.platform !== "win32")(
  "reports an interactive wait and later completion without inventing an exit code",
  async () => {
    const { manager, session } = start(
      "printf 'Choose [y/N]: '; IFS= read -r answer; printf 'choice:%s' \"$answer\"",
    );
    await manager.waitForForeground(session.source, { timeoutMs: 5000, interactiveDelayMs: 40 });
    const waiting = await structuredShellResult(manager.snapshot(session));
    expect(waiting).toMatchObject({
      status: "running",
      background: true,
      wait_reason: "interactive",
    });
    expect(waiting).not.toHaveProperty("exit_code");
    await manager.write(session.source, "y");
    await manager.sendKeys(session.source, "Enter");
    await manager.wait(session.source);
    const completed = await structuredShellResult(manager.snapshot(session));
    expect(completed).toMatchObject({ status: "completed", exit_code: 0, source: waiting.source });
    expect(completed.output).toContain("choice:y");
  },
);

test.runIf(process.platform !== "win32")(
  "aborting a foreground wait leaves structured access to the live session",
  async () => {
    const { manager, session } = start("IFS= read -r answer; printf '%s' \"$answer\"");
    const controller = new AbortController();
    const wait = manager.waitForForeground(session.source, {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    await wait;
    const result = await structuredShellResult(manager.snapshot(session));
    expect(result).toMatchObject({ status: "running", background: true });
    expect(result).not.toHaveProperty("exit_code");
    expect(result).not.toHaveProperty("wait_reason");
    await manager.write(session.source, "alive");
    await manager.sendKeys(session.source, "Enter");
    await manager.wait(session.source);
    expect((await structuredShellResult(manager.snapshot(session))).output).toContain("alive");
  },
);
