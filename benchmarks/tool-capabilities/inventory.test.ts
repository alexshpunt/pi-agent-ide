import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { piRuntime, toolInventory } from "./inventory.ts";

const repository = findRepositoryRoot(import.meta.url);
const windowsTarget = {
  targets: [{ id: "windows", host: "windows-host", workspace: "C:/work", os: "windows" }],
};

void test("the local pnpm launcher and direct CLI resolve the same runtime", async () => {
  const launcher = path.join(repository, "node_modules/.bin/pi");
  const cli = path.join(
    repository,
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  const direct = await piRuntime(cli);
  assert.deepEqual(await piRuntime(launcher), direct);
  const inventory = await toolInventory(repository, launcher);
  assert.equal(inventory.pi, direct.version);
  assert.ok(inventory.tools.length > 0);
  assert.equal(await realpath(direct.cli), await realpath(cli));
  assert.equal(
    await realpath(direct.sdk),
    await realpath(path.join(direct.directory, "dist/index.js")),
  );
});

void test("a pnpm launcher with an unavailable target does not fall back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-missing-pi-"));
  try {
    const launcher = path.join(root, "node_modules/.bin/pi");
    await mkdir(path.dirname(launcher), { recursive: true });
    const shim = await readFile(path.join(repository, "node_modules/.bin/pi"));
    await writeFile(launcher, shim, { mode: 0o755 });
    await assert.rejects(piRuntime(launcher));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test("an unsupported launcher does not resolve a different Pi runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-launcher-"));
  try {
    const launcher = path.join(root, "pi");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await assert.rejects(piRuntime(launcher));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
void test("configured SSH targets do not change the live inventory", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "capability-ssh-")));
  const previousDirectory = process.cwd();
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    const agent = path.join(root, "agent");
    const project = path.join(root, "project");
    for (const directory of [
      path.join(agent, "pi-agent-ide"),
      path.join(project, ".pi", "pi-agent-ide"),
    ])
      await mkdir(directory, { recursive: true });
    await writeFile(path.join(agent, "pi-agent-ide", "ssh.json"), JSON.stringify(windowsTarget));
    await writeFile(
      path.join(project, ".pi", "pi-agent-ide", "ssh.json"),
      JSON.stringify(windowsTarget),
    );
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(project);

    const names = new Set((await toolInventory(repository)).tools.map((tool) => tool.name));

    assert.ok(!names.has("remote_powershell"));
    assert.ok(!names.has("remote_bash"));
    assert.equal(process.cwd(), project);
    assert.equal(process.env.PI_CODING_AGENT_DIR, agent);
  } finally {
    process.chdir(previousDirectory);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  }
});
