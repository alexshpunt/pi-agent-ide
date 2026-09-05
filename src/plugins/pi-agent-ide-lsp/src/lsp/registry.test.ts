import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { LspServerRegistry } from "./registry.js";

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

test("does not select an unavailable shipped LSP server", async () => {
  const project = await temporaryDirectory("lsp-built-in-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("lsp-built-in-agent-");

  const registry = await LspServerRegistry.fromPackageDir(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve(".ts")).toEqual([]);
  expect(registry.entries.some((entry) => entry.id === "typescript-language-server")).toBe(true);
});

test("selects an available project-local shipped LSP server", async () => {
  const project = await temporaryDirectory("lsp-available-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("lsp-available-agent-");
  const bin = path.join(project, "node_modules", ".bin");
  const executable = path.join(bin, "typescript-language-server");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  const registry = await LspServerRegistry.fromPackageDir(project, {
    environment: { PATH: "" },
  });

  expect(registry.resolve(".ts")[0]).toMatchObject({
    serverId: "typescript-language-server",
    languageId: "typescript",
  });
});

test("orders project servers before matching global and built-in servers", async () => {
  const project = await temporaryDirectory("lsp-layer-project-");
  const agentDirectory = await temporaryDirectory("lsp-layer-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "lsp-servers.json"), {
    version: 1,
    servers: {
      shared: server(".global", "global-shared"),
      "global-custom": server(".custom", "global-lsp"),
      collision: server(".collision", "global-collision"),
    },
  });
  await writeConfig(path.join(project, ".pi", "pi-agent-ide", "lsp-servers.json"), {
    version: 1,
    servers: {
      shared: server(".project", "project-shared"),
      collision: server(".collision", "project-collision"),
    },
  });

  const registry = await LspServerRegistry.fromPackageDir(project);

  expect(registry.resolve(".project")[0]?.config.command[0]).toBe("project-shared");
  expect(registry.resolve(".custom")[0]?.config.command[0]).toBe("global-lsp");
  expect(registry.resolve(".collision")[0]?.config.command[0]).toBe("project-collision");
  expect(registry.resolve(".global").some((entry) => entry.serverId === "shared")).toBe(false);
});

function server(extension: string, executable: string): Record<string, unknown> {
  return {
    command: [executable],
    rootMarkers: [],
    languages: { fixture: { extensions: [extension] } },
    capabilities: ["diagnostics"],
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
