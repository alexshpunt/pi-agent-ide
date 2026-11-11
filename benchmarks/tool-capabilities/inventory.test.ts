import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findRepositoryRoot } from "#scripts/repository-root.ts";
import { toolInventory } from "./inventory.ts";

const repository = findRepositoryRoot(import.meta.url);
const windowsTarget = {
  targets: [{ id: "windows", host: "windows-host", workspace: "C:/work", os: "windows" }],
};

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
