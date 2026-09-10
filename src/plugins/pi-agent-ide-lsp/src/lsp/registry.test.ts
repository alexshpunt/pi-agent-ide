import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { LspServerRegistry, parseLspConfig } from "./registry.js";

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

test("external-project mode rejects an available unevidenced LSP server", async () => {
  const project = await temporaryDirectory("lsp-external-unevidenced-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("lsp-external-agent-");
  const bin = path.join(project, "node_modules", ".bin");
  const executable = path.join(bin, "typescript-language-server");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  const registry = await LspServerRegistry.fromPackageDir(project, {
    environment: { PATH: "" },
    includeGlobal: false,
    requireBuiltInEvidence: true,
    recipes: [typescriptRecipe()],
  });

  expect(registry.resolve(".ts")).toEqual([]);
});
test("selects an available project-local shipped LSP server", async () => {
  const project = await temporaryDirectory("lsp-available-project-");
  process.env.PI_CODING_AGENT_DIR = await temporaryDirectory("lsp-available-agent-");
  const bin = path.join(project, "node_modules", ".bin");
  const executable = path.join(bin, "typescript-language-server");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  await writeFile(path.join(project, "tsconfig.json"), "{}");

  const registry = await LspServerRegistry.fromPackageDir(project, {
    environment: { PATH: "" },
    requireBuiltInEvidence: true,
    recipes: [typescriptRecipe()],
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

test("routes exact native basenames without claiming unrelated text files", () => {
  const registry = LspServerRegistry.fromConfig({
    version: 1,
    servers: {
      cmake: {
        command: ["cmake-language-server"],
        rootMarkers: [],
        capabilities: ["diagnostics"],
        languages: { cmake: { extensions: [".cmake"], fileNames: ["CMakeLists.txt"] } },
      },
      docker: {
        command: ["docker-langserver"],
        rootMarkers: [],
        capabilities: ["diagnostics"],
        languages: {
          dockerfile: { extensions: [".dockerfile"], fileNames: ["Dockerfile", "Containerfile"] },
        },
      },
    },
  });
  expect(registry.resolve(path.join("project with spaces", "CMakeLists.txt"))[0]?.serverId).toBe(
    "cmake",
  );
  expect(registry.languageId("Dockerfile")).toBe("dockerfile");
  expect(registry.resolve("Containerfile")[0]?.serverId).toBe("docker");
  expect(registry.resolve("README.txt")).toEqual([]);
  expect(registry.resolve("Dockerfile.backup")).toEqual([]);
  expect(registry.resolve("module.cmake")[0]?.serverId).toBe("cmake");
  expect(registry.resolve(".cmake")[0]?.serverId).toBe("cmake");
});

test("gates framework servers by the file's native project, including nested projects", async () => {
  const project = await temporaryDirectory("lsp-framework-");
  const framework = path.join(project, "apps", "frontend");
  await mkdir(framework, { recursive: true });
  const registry = LspServerRegistry.fromConfig(
    {
      version: 1,
      servers: {
        angular: {
          command: ["ngserver"],
          rootMarkers: ["angular.json"],
          requireRootMarker: true,
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
        generic: {
          command: ["typescript-language-server"],
          rootMarkers: [],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
      },
    },
    project,
  );
  const file = path.join(framework, "src", "main.ts");
  expect(registry.resolve(file).map((entry) => entry.serverId)).toEqual(["generic"]);
  await writeFile(path.join(framework, "angular.json"), "{}");
  expect(registry.resolve(file).map((entry) => entry.serverId)).toEqual(["angular", "generic"]);
  expect(registry.resolve("library.ts").map((entry) => entry.serverId)).toEqual(["generic"]);
  expect(registry.resolve(".ts").map((entry) => entry.serverId)).toEqual(["generic"]);
  await writeFile(path.join(project, "angular.json"), "{}");
  expect(registry.resolve(".ts")[0]?.serverId).toBe("angular");
});

test("validates native marker gates before loading a server", () => {
  const config = (requireRootMarker: unknown, rootMarkers: string[]) => ({
    version: 1,
    servers: { framework: { ...server(".ts", "ngserver"), requireRootMarker, rootMarkers } },
  });
  expect(() => parseLspConfig(config("true", ["angular.json"]))).toThrow(TypeError);
  expect(() => parseLspConfig(config(true, []))).toThrow(Error);
  expect(parseLspConfig(config(true, ["angular.json"])).servers.framework?.requireRootMarker).toBe(
    true,
  );
  expect(parseLspConfig(config(false, [])).servers.framework?.requireRootMarker).toBe(false);
});

function typescriptRecipe() {
  return {
    id: "typescript-language-server",
    name: "typescript-language-server",
    kind: "lsp" as const,
    languages: ["typescript"],
    executables: ["typescript-language-server"],
    configFiles: ["tsconfig.json"],
    documentation: "https://example.test",
  };
}
function server(extension: string, executable: string): Record<string, unknown> {
  return {
    command: [executable],
    rootMarkers: [],
    languages: { fixture: { extensions: [extension] } },
    capabilities: ["diagnostics"],
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = path.resolve(".agents/tmp/lsp-registry-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, prefix));
  directories.push(directory);
  return directory;
}

async function writeConfig(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}
