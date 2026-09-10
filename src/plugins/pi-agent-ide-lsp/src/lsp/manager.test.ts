import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";

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
