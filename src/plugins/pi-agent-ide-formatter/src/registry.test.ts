import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { FORMATTER_RECIPES } from "./catalog.js";
import { FormatterCommandRegistry } from "./registry.js";

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

test("keeps shipped formatters but does not select unavailable commands", async () => {
  const project = await temporaryDirectory("formatter-built-in-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("formatter-built-in-agent-");

  const registry = await FormatterCommandRegistry.fromDirectory(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve("source.ts", project)).toBeUndefined();

  const builtIn = registry.entries.filter((entry) => entry.layer === "built-in");
  expect(builtIn.map((entry) => entry.id)).toEqual(FORMATTER_RECIPES.map((recipe) => recipe.id));
  for (const recipe of FORMATTER_RECIPES) {
    expect(builtIn.find((entry) => entry.id === recipe.id)?.config).toMatchObject(
      recipe.formatter ?? {},
    );
  }
});

test("selects the first available shipped formatter", async () => {
  const project = await temporaryDirectory("formatter-available-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("formatter-available-agent-");
  const bin = path.join(project, "node_modules", ".bin");
  const executable = path.join(bin, "oxfmt");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  const registry = await FormatterCommandRegistry.fromDirectory(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve("source.ts", project)?.run.command[0]).toBe("oxfmt");
});

test("orders project entries before global and built-in entries and replaces matching IDs whole", async () => {
  const project = await temporaryDirectory("formatter-layer-project-");
  const agentDirectory = await temporaryDirectory("formatter-layer-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "formatters.json"), {
    version: 1,
    formatters: {
      shared: formatter(".global", "global-shared"),
      "global-custom": formatter(".global", "global-custom"),
      collision: formatter(".collision", "global-collision"),
    },
  });
  await writeConfig(path.join(project, ".pi", "pi-agent-ide", "formatters.json"), {
    version: 1,
    formatters: {
      shared: formatter(".project", "project-shared"),
      collision: formatter(".collision", "project-collision"),
    },
  });

  const registry = await FormatterCommandRegistry.fromDirectory(project);

  expect(registry.resolve("source.project", project)?.run.command[0]).toBe("project-shared");
  expect(registry.resolve("source.global", project)?.run.command[0]).toBe("global-custom");
  expect(registry.resolve("source.collision", project)?.run.command[0]).toBe("project-collision");
});

test("an invalid global formatter file fails this configuration category", async () => {
  const project = await temporaryDirectory("formatter-invalid-project-");
  const agentDirectory = await temporaryDirectory("formatter-invalid-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "formatters.json"), {
    version: 1,
    formatters: { broken: { extensions: [".ts"] } },
  });

  await expect(FormatterCommandRegistry.fromDirectory(project)).rejects.toThrow(
    /global.*formatters\.json.*broken/is,
  );
});

function formatter(extension: string, executable: string): Record<string, unknown> {
  return {
    extensions: [extension],
    run: { command: [executable, "{file}"] },
    output: "in-place",
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
