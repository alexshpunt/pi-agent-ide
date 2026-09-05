import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  readPiAgentIdeExtensionsConfig,
  resolvePiAgentIdeExtensionsConfigPaths,
} from "./extensions-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Pi Agent IDE extension config", () => {
  test("resolves project and global config paths", () => {
    expect(
      resolvePiAgentIdeExtensionsConfigPaths(
        { PI_CODING_AGENT_DIR: "/home/example/.pi/agent" },
        "/home/example",
        "/workspace/project",
      ),
    ).toEqual({
      globalPath: "/home/example/.pi/agent/pi-agent-ide/extensions.json",
      projectPath: "/workspace/project/.pi/pi-agent-ide/extensions.json",
    });
  });

  test("returns empty lists when both config files are absent", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await expect(readPiAgentIdeExtensionsConfig(paths)).resolves.toEqual({
      disabled: [],
      enabled: [],
    });
  });

  test("merges disabled IDs from global and project config without duplicates", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await writeJson(paths.globalPath, { disabled: ["editor.overwrite", "editor.argument-order"] });
    await writeJson(paths.projectPath, {
      disabled: ["editor.argument-order", "editor.stale-anchor"],
    });

    await expect(readPiAgentIdeExtensionsConfig(paths)).resolves.toEqual({
      disabled: ["editor.overwrite", "editor.argument-order", "editor.stale-anchor"],
      enabled: [],
    });
  });

  test("merges enabled IDs from global and project config without duplicates", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await writeJson(paths.globalPath, { enabled: ["editor.argument-order"] });
    await writeJson(paths.projectPath, { enabled: ["editor.argument-order", "ide.lsp"] });

    await expect(readPiAgentIdeExtensionsConfig(paths)).resolves.toEqual({
      disabled: [],
      enabled: ["editor.argument-order", "ide.lsp"],
    });
  });

  test("rejects duplicate IDs in one config file for either field", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await writeJson(paths.globalPath, { disabled: ["editor.core", "editor.core"] });
    await expect(readPiAgentIdeExtensionsConfig(paths)).rejects.toThrow(
      /disabled in .* must not contain duplicate IDs/,
    );

    await writeJson(paths.globalPath, { enabled: ["editor.core", "editor.core"] });
    await expect(readPiAgentIdeExtensionsConfig(paths)).rejects.toThrow(
      /enabled in .* must not contain duplicate IDs/,
    );
  });

  test("rejects a non-array value in either field", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await writeJson(paths.globalPath, { disabled: "editor.core" });
    await expect(readPiAgentIdeExtensionsConfig(paths)).rejects.toThrow(
      /disabled in .* must be an array of non-empty strings/,
    );

    await writeJson(paths.globalPath, { enabled: [42] });
    await expect(readPiAgentIdeExtensionsConfig(paths)).rejects.toThrow(
      /enabled in .* must be an array of non-empty strings/,
    );
  });

  test("rejects invalid JSON with the config path", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      globalPath: path.join(directory, "global", "extensions.json"),
      projectPath: path.join(directory, "project", "extensions.json"),
    };

    await mkdir(path.dirname(paths.projectPath), { recursive: true });
    await writeFile(paths.projectPath, "not json");

    await expect(readPiAgentIdeExtensionsConfig(paths)).rejects.toThrow(
      `Invalid JSON in Pi Agent IDE extension config at ${paths.projectPath}`,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = path.resolve(
    process.cwd(),
    ".agents",
    "tmp",
    `extensions-config-test-${randomUUID()}`,
  );
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}
