import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRemoteProject, remoteProject, sshArguments, sshTargets } from "#unity/remote.ts";

void test("project Windows target overrides a global Linux target with the same id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unity-ssh-override-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const cwd = process.cwd();
  try {
    const global = path.join(dir, "agent", "pi-agent-ide");
    const project = path.join(dir, "project", ".pi", "pi-agent-ide");
    await mkdir(global, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(global, "ssh.json"),
      JSON.stringify({
        targets: [{ id: "studio", host: "linux", workspace: "/work", os: "linux" }],
      }),
    );
    await writeFile(
      path.join(project, "ssh.json"),
      JSON.stringify({
        targets: [{ id: "studio", host: "windows", workspace: "C:/work", os: "windows" }],
      }),
    );
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    process.chdir(path.join(dir, "project"));
    assert.deepEqual(await sshTargets(), []);
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SSH project paths retain their target and decode special characters", () => {
  const source = remoteProject("studio", "/home/me/My Game");
  assert.equal(source, "ssh://studio/home/me/My%20Game");
  assert.deepEqual(parseRemoteProject(source), { target: "studio", path: "/home/me/My Game" });
  assert.equal(parseRemoteProject("/local/project"), undefined);
  assert.throws(() => parseRemoteProject("ssh://studio/home/me/project?other"));
});

void test("remote command arguments cannot become shell syntax", () => {
  const args = sshArguments({ id: "studio", host: "user@host", workspace: "/home/me" }, "unity", [
    "status; touch /tmp/no",
  ]);
  assert.ok(args.includes("ConnectTimeout=10"));
  const bootstrap = args.at(-1);
  assert.ok(bootstrap);
  assert.equal(bootstrap.includes("status; touch"), false);
  assert.throws(() =>
    sshArguments({ id: "studio", host: "-oProxyCommand=bad", workspace: "/home/me" }, "unity", []),
  );
});

// Pi Agent IDE's shared ssh.json also lists native Windows targets ("os": "windows"); they must not break Unity's Linux targets.
void test("shared SSH settings with native Windows targets keep the Linux targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unity-ssh-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(path.join(dir, "pi-agent-ide"));
    await writeFile(
      path.join(dir, "pi-agent-ide", "ssh.json"),
      JSON.stringify({
        targets: [
          { id: "pc-wsl", host: "pc-wsl", workspace: "/home/tester", os: "linux" },
          { id: "pc-win", host: "pc-win", workspace: "C:/Users/tester", os: "windows" },
        ],
      }),
    );
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.deepEqual(
      (await sshTargets()).map((t) => t.id),
      ["pc-wsl"],
    );
    await writeFile(
      path.join(dir, "pi-agent-ide", "ssh.json"),
      JSON.stringify({ targets: [{ id: "x", host: "x", workspace: "/w", os: "mac" }] }),
    );
    await assert.rejects(sshTargets(), /Invalid SSH settings/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
