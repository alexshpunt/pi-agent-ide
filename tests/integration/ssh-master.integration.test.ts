import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.ts";
import { stopSshMasters } from "#src/backend/ssh-master.ts";
import { startSshFixture, type SshFixture } from "#integration/support/ssh-fixture.ts";

const run = promisify(execFile);
const directory = `/tmp/pi-ssh-${process.getuid?.() ?? 0}`;
const fixtures: SshFixture[] = [];
afterEach(async () => {
  stopSshMasters();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

async function backendFor(policy: { readonly multiplex?: boolean } = {}) {
  const fixture = await startSshFixture({}, {}, undefined, policy);
  fixtures.push(fixture);
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  return { fixture, backend };
}

/** Sockets of this process's masters. */
async function ownSockets(): Promise<string[]> {
  const names = await readdir(directory).catch(() => []);
  return names.filter((name) => name.startsWith(`${process.pid}-`)).sort();
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The PID OpenSSH reports for the master behind a socket. */
async function masterPid(config: string, socket: string): Promise<number> {
  const { stderr } = await run("ssh", [
    "-F",
    config,
    "-o",
    `ControlPath=${directory}/${socket}`,
    "-O",
    "check",
    "fixture",
  ]);
  const pid = Number(/pid=(\d+)/u.exec(stderr)?.[1]);
  if (!Number.isSafeInteger(pid)) throw new Error("Missing master PID");
  return pid;
}

test("sequential requests reuse one master, which stops with its process", async () => {
  const { fixture, backend } = await backendFor();
  for (let index = 0; index < 4; index++) await backend.lstat(fixture.workspace);
  const sockets = await ownSockets();
  expect(sockets).toHaveLength(1);
  const pid = await masterPid(fixture.config, sockets[0] ?? "");
  await Promise.all(Array.from({ length: 3 }, () => backend.lstat(fixture.workspace)));
  expect(await masterPid(fixture.config, sockets[0] ?? "")).toBe(pid);
  stopSshMasters();
  // `ssh -O exit` returns once the master accepted the request; it exits right after.
  await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false);
  expect(await ownSockets()).toEqual([]);
}, 60_000);

test("a killed master is replaced and no request fails", async () => {
  const { fixture, backend } = await backendFor();
  await backend.lstat(fixture.workspace);
  const [first] = await ownSockets();
  process.kill(await masterPid(fixture.config, first ?? ""), "SIGKILL");
  // The stale socket stays behind a SIGKILL; requests must not hang on it.
  expect(await backend.lstat(fixture.workspace)).toMatchObject({ kind: "directory" });
  expect(await backend.lstat(fixture.workspace)).toMatchObject({ kind: "directory" });
  const sockets = await ownSockets();
  expect(sockets).toHaveLength(1);
  expect(sockets[0]).not.toBe(first);
}, 60_000);

test("concurrent requests beyond one master's sessions open more masters", async () => {
  const { fixture, backend } = await backendFor();
  await backend.lstat(fixture.workspace);
  const results = await Promise.all(
    Array.from({ length: 24 }, () => backend.lstat(fixture.workspace)),
  );
  expect(results.every((result) => result.kind === "directory")).toBe(true);
  const count = (await ownSockets()).length;
  expect(count).toBeGreaterThan(1);
  expect(count).toBeLessThanOrEqual(4);
}, 60_000);

test("a user's own ControlPath is used instead of a Pi master", async () => {
  const { fixture, backend } = await backendFor({ multiplex: true });
  await backend.lstat(fixture.workspace);
  expect(await ownSockets()).toEqual([]);
}, 60_000);
