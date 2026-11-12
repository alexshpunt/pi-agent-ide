import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.ts";
import { LspManager } from "./manager.ts";
import { LspServerRegistry } from "./registry.ts";
import { LspSharedServers } from "./shared-servers.ts";
import { searchSymbols } from "./symbol-search.ts";

/** Startup timeout of a server that exits during startup; reporting the exit must not wait for it. */
const STARTUP_TIMEOUT_MS = 10_000;

const directories: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("a source written while its snapshot is read is reported as a changed source, so the request runs again", async () => {
  const root = path.resolve(".agents/tmp/lsp-source-snapshot");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  directories.push(cwd);
  const source = path.join(cwd, "main.cpp");
  await writeFile(source, "int a;\n");
  const manager = LspManager.init(LspServerRegistry.fromConfig({ version: 1, servers: {} }, cwd));
  const read = manager.readSourceText.bind(manager);
  vi.spyOn(manager, "readSourceText").mockImplementation(async (file, signal) => {
    const content = await read(file, signal);
    // Another session appends a line while the snapshot is being read.
    await writeFile(source, "int a;\nint b;\n");
    return content;
  });
  await expect(manager.readSourceSnapshot(source)).rejects.toMatchObject({
    code: "SOURCE_CHANGED",
  });
});

test.each([false, true])(
  "workspace symbols start only servers for present source files (source=%s)",
  async (present) => {
    const root = path.resolve(".agents/tmp/lsp-workspace-discovery");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    directories.push(cwd);
    if (present) await writeFile(path.join(cwd, "example.ts"), "export const value = 1;\n");
    await mkdir(path.join(cwd, "node_modules"));
    await writeFile(path.join(cwd, "node_modules", "ignored.py"), "value = 1\n");
    const started: string[] = [];
    vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: LspClient) {
      started.push(this.serverId);
    });
    vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue();
    vi.spyOn(LspClient.prototype, "hasWorkspaceSymbolCapability", "get").mockReturnValue(true);
    vi.spyOn(LspClient.prototype, "openDocument").mockImplementation(() => {});
    const registry = LspServerRegistry.fromConfig(
      {
        version: 1,
        servers: {
          typescript: {
            command: ["typescript-language-server"],
            rootMarkers: [],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
          unrelated: {
            command: ["unrelated-server"],
            rootMarkers: [],
            languages: { python: { extensions: [".py"] } },
            capabilities: ["diagnostics"],
          },
        },
      },
      cwd,
    );
    const clients = await LspManager.init(registry).prepareWorkspaceSymbols(cwd);
    expect(started).toEqual(present ? ["typescript"] : []);
    expect(clients.map((client) => client.serverId)).toEqual(started);
  },
);

test.each([
  { supported: "true", unsupported: "false" },
  { supported: "{}", unsupported: "null" },
  { supported: "true", unsupported: "absent" },
])("workspace symbols use advertised providers (%s)", async ({ supported, unsupported }) => {
  const manager = await workspaceProviderFixture(supported, unsupported);
  const cwd = directories[directories.length - 1];
  if (cwd === undefined) throw new Error("Missing fixture directory");
  const clients = await manager.prepareWorkspaceSymbols(cwd);
  expect(clients.map((client) => client.serverId)).toEqual(["typescript"]);
  await expect(searchSymbols("value", cwd, 100, undefined, {}, manager)).resolves.toEqual({
    hits: [],
    contents: new Map(),
    complete: true,
  });
  await expect(
    searchSymbols("value", cwd, 100, undefined, { path: "config.json" }, manager),
  ).rejects.toThrow(/unavailable/iu);
});

test("workspace symbols preserve errors from an advertised provider", async () => {
  const manager = await workspaceProviderFixture("true", "false", true);
  const cwd = directories[directories.length - 1];
  if (cwd === undefined) throw new Error("Missing fixture directory");
  await expect(searchSymbols("value", cwd, 100, undefined, {}, manager)).rejects.toThrow(
    "eligible workspace request failed",
  );
});

test.each([false, true])(
  "a server that exits during startup reports its error at once and starts on a later call (shared=%s)",
  async (shared) => {
    const root = path.resolve(".agents/tmp/lsp-startup-exit");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    // Socket paths have a short length limit, so they live in the system temporary directory.
    const sockets = await mkdtemp(path.join(os.tmpdir(), "lsp-startup-"));
    directories.push(cwd, sockets);
    await writeFile(path.join(cwd, "main.fx"), "value\n");
    const installed = path.join(cwd, "installed");
    const server = path.resolve(
      "src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/document-lifecycle-server.mjs",
    );
    // Like the rustup proxy when the rust-analyzer component is missing.
    const proxy = path.join(cwd, "proxy.mjs");
    await writeFile(
      proxy,
      [
        'import { existsSync } from "node:fs";',
        `if (!existsSync(${JSON.stringify(installed)})) {`,
        "  process.stderr.write(\"error: Unknown binary 'fixture-server' in official toolchain\\n\");",
        "  process.exit(1);",
        "}",
        `await import(${JSON.stringify(pathToFileURL(server).href)});`,
      ].join("\n"),
    );
    const manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            fixture: {
              command: [process.execPath, proxy],
              timeoutMs: STARTUP_TIMEOUT_MS,
              rootMarkers: [],
              languages: { fixture: { extensions: [".fx"] } },
              capabilities: ["diagnostics"],
            },
          },
        },
        cwd,
      ),
      undefined,
      shared ? { sharedServers: new LspSharedServers({ directory: sockets }) } : {},
    );

    const started = Date.now();
    await expect(manager.getOrStart(".fx", cwd, "symbols")).rejects.toThrow(
      "[lsp] fixture exited during startup with code 1: error: Unknown binary 'fixture-server' in official toolchain",
    );
    // Starting the process (and the shared host) can take seconds on a busy machine; the exit must
    // still be reported well before the startup timeout would end the wait.
    expect(Date.now() - started).toBeLessThan(STARTUP_TIMEOUT_MS / 2);

    await writeFile(installed, "");
    const client = await manager.getOrStart(".fx", cwd, "symbols");
    expect(client?.ready).toBe(true);
  },
  STARTUP_TIMEOUT_MS * 2,
);

test.each([false, true])(
  "requests wait while the server loads the project and fail if it takes too long (shared=%s)",
  async (shared) => {
    const root = path.resolve(".agents/tmp/lsp-loading");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    // Socket paths have a short length limit, so they live in the system temporary directory.
    const sockets = await mkdtemp(path.join(os.tmpdir(), "lsp-loading-"));
    directories.push(cwd, sockets);
    await writeFile(path.join(cwd, "main.fx"), "value\n");
    await writeFile(path.join(cwd, "main.slow"), "value\n");
    const server = path.resolve(
      "src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/document-lifecycle-server.mjs",
    );
    const manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            loading: {
              command: [process.execPath, server],
              env: { LIFECYCLE_LOADING_MS: "500" },
              rootMarkers: [],
              languages: { fixture: { extensions: [".fx"] } },
              capabilities: ["diagnostics"],
            },
            stuck: {
              command: [process.execPath, server],
              env: { LIFECYCLE_LOADING_MS: "60000" },
              // Also bounds initialize, so leave room for a slow start under a busy test run.
              timeoutMs: 3000,
              rootMarkers: [],
              languages: { slow: { extensions: [".slow"] } },
              capabilities: ["diagnostics"],
            },
          },
        },
        cwd,
      ),
      undefined,
      shared ? { sharedServers: new LspSharedServers({ directory: sockets }) } : {},
    );

    const opened = await manager.openFile("main.fx", cwd, "symbols");
    expect(opened?.client.loading).toBe(false);
    expect(await opened?.client.sendRequest("lifecycle/loaded", {})).toBe(true);

    // The first status can arrive after the file opens; then the request itself waits.
    const stuck = manager
      .openFile("main.slow", cwd, "symbols")
      .then((slow) => slow?.client.sendRequest("lifecycle/loaded", {}));
    await expect(stuck).rejects.toMatchObject({
      code: "SERVER_LOADING",
      message:
        "[lsp] stuck is still loading the project (Loading); its results would be incomplete. Try again later.",
    });
  },
  // The wait for the stuck server alone takes its 3 s timeout, after two server starts.
  20_000,
);

async function workspaceProviderFixture(
  supported: string,
  unsupported: string,
  fail = false,
): Promise<LspManager> {
  const root = path.resolve(".agents/tmp/lsp-workspace-discovery");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "providers-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "example.ts"), "export const value = 1;\n");
  await writeFile(path.join(cwd, "config.json"), "{}\n");
  const server = path.resolve(
    "src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/workspace-symbol-server.mjs",
  );
  return LspManager.init(
    LspServerRegistry.fromConfig(
      {
        version: 1,
        servers: {
          typescript: {
            command: [process.execPath, server, supported, ...(fail ? ["fail"] : [])],
            rootMarkers: [],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
          json: {
            command: [process.execPath, server, unsupported],
            rootMarkers: [],
            languages: { json: { extensions: [".json"] } },
            capabilities: ["diagnostics"],
          },
        },
      },
      cwd,
    ),
  );
}
