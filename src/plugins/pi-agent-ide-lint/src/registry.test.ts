import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { LINTER_RECIPES } from "./catalog.js";
import { LintCommandRegistry } from "./registry.js";

const directories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalAgentDirectory === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("keeps shipped linters but does not select unavailable commands", async () => {
  const project = await temporaryDirectory("linter-built-in-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("linter-built-in-agent-");

  const registry = await LintCommandRegistry.fromDirectory(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve("source.ts", project)).toBeUndefined();

  const builtIn = registry.entries.filter((entry) => entry.layer === "built-in");
  expect(builtIn.map((entry) => entry.id)).toEqual(LINTER_RECIPES.map((recipe) => recipe.id));
  for (const recipe of LINTER_RECIPES) {
    expect(builtIn.find((entry) => entry.id === recipe.id)?.config).toMatchObject(
      recipe.linter ?? {},
    );
  }
});

test("selects the first available shipped linter", async () => {
  const project = await temporaryDirectory("linter-available-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("linter-available-agent-");
  const bin = path.join(project, "node_modules", ".bin");
  const executable = path.join(bin, "oxlint");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  const registry = await LintCommandRegistry.fromDirectory(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve("source.ts", project)?.check.command[0]).toBe("oxlint");
});

test("a project linter beats a different matching global linter", async () => {
  const project = await temporaryDirectory("linter-layer-project-");
  const agentDirectory = await temporaryDirectory("linter-layer-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "linters.json"), {
    version: 1,
    linters: { "global-custom": linter("global-lint") },
  });
  await writeConfig(path.join(project, ".pi", "pi-agent-ide", "linters.json"), {
    version: 1,
    linters: { "project-custom": linter("project-lint") },
  });

  const registry = await LintCommandRegistry.fromDirectory(project);

  expect(registry.resolve("source.custom", project)?.check.command[0]).toBe("project-lint");
});

function linter(executable: string): Record<string, unknown> {
  return {
    extensions: [".custom"],
    check: { command: [executable, "{file}"] },
    diagnostics: { format: "gcc" },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function writeConfig(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}
