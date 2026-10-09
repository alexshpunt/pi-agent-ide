import { afterAll, beforeAll, expect, test } from "vitest";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { terminalProcessProvider } from "#src/plugins/pi-agent-ide-terminal/src/process-provider.js";
import { startSshFixture, type SshFixture } from "#integration/support/ssh-fixture.js";

let fixture: SshFixture;
let registry: SshBackendRegistry;
const manager = new TerminalSessionManager();
beforeAll(async () => {
  fixture = await startSshFixture();
  registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
});
afterAll(async () => {
  await manager.dispose();
  await fixture.stop();
});

function remote() {
  const result = registry.resolve(`ssh://fixture${fixture.workspace}`);
  if (!result) throw new Error("Missing fixture target");
  return result;
}

test("remote shell sessions reuse output, screens and input without claiming a local process PID", async () => {
  const session = await manager.startRemote({
    command: "printf 'ready\\n'; read answer; printf 'answer=%s\\n' \"$answer\"",
    background: false,
    remote: remote(),
    cols: 90,
    rows: 25,
  });
  try {
    const snapshot = manager.snapshot(session);
    expect(snapshot.cwd).toBe(`ssh://fixture${fixture.workspace}`);
    expect(snapshot.pid).toBeUndefined();
    expect(snapshot.remote?.target).toBe("fixture");
    expect(snapshot.remote?.pid).toBeGreaterThan(0);
    expect(snapshot.remote?.identity).toMatch(/^[a-f0-9-]+:\d+$/u);
    const processEntry = terminalProcessProvider(manager)
      .list()
      .find((entry) => entry.source === session.source);
    expect(processEntry?.pid).toBeUndefined();
    expect(processEntry?.owned).toBe(true);
    expect(processEntry?.remote).toEqual(snapshot.remote);
    await manager.write(session.source, "hello");
    await manager.sendKeys(session.source, "Enter");
    const completed = await manager.wait(session.source);
    expect(completed.status).toBe("completed");
    expect(completed.output).toContain("answer=hello");
    expect((await manager.screenLines(session.source)).join("\n")).toContain("answer=hello");
  } finally {
    await manager.delete(session.source);
  }
});

test("foreground turn abort keeps a remote shell available for later input", async () => {
  const controller = new AbortController();
  const session = await manager.startRemote({
    command: "read answer; printf 'answer=%s\\n' \"$answer\"",
    background: false,
    remote: remote(),
    signal: controller.signal,
  });
  try {
    controller.abort();
    const outcome = await manager.waitForForeground(session.source, {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    expect(outcome.reason).toBe("aborted");
    expect(outcome.session.status).toBe("running");
    expect(outcome.session.background).toBe(true);
    await manager.write(session.source, "café");
    await manager.sendKeys(session.source, "Enter");
    expect((await manager.wait(session.source)).output).toContain("answer=café");
  } finally {
    await manager.delete(session.source);
  }
});

test("disposing a manager during remote startup does not leave a live shell", async () => {
  const disposable = new TerminalSessionManager();
  const starting = disposable.startRemote({
    command: "sleep 120",
    background: true,
    remote: remote(),
  });
  await disposable.dispose();
  const session = await starting;
  try {
    expect(session.status).not.toBe("running");
    expect(session.endedAt).toBeDefined();
    expect(await session.completion).toBe(session);
  } finally {
    await disposable.delete(session.source);
  }
});

test("remote shell stop uses its channel and retains a truthful final session", async () => {
  const session = await manager.startRemote({
    command: "sleep 120",
    background: true,
    remote: remote(),
  });
  const stopped = await manager.stop(session.source);
  expect(stopped.status).toBe("stopped");
  expect(manager.snapshot(stopped).remote?.target).toBe("fixture");
  await manager.delete(session.source);
});
