import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";
import { searchSymbols } from "./symbol-search.js";

const directories: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
