import { expect, test } from "vitest";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { SshBackendError, type SshBackend } from "#src/backend/ssh.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import { searchSymbols } from "#src/plugins/pi-agent-ide-lsp/src/lsp/symbol-search.js";
import { readLspSymbolGraph } from "#src/plugins/pi-agent-ide-lsp/src/lsp/code-views.js";
import { sshProjectExecutableAvailability } from "#src/backend/process-environment.js";
import { LspClient } from "#src/plugins/pi-agent-ide-lsp/src/lsp/client.js";
import { completedDiagnosticAdapter } from "#src/plugins/pi-agent-ide-lsp/src/lsp/diagnostic-adapters.js";
import { createLspCompiler } from "#src/plugins/pi-agent-ide-lsp/src/lsp/lsp-compiler.js";

const host = process.env.PI_IDE_SSH_SMOKE_HOST;

async function removeOwnedSources(
  backend: SshBackend,
  directory: string,
  names: readonly string[],
) {
  for (const name of names) {
    const file = `${directory}/${name}`;
    try {
      await backend.remove(file, (await backend.read(file)).version);
    } catch (error) {
      if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
    }
  }
}

test.skipIf(!host)(
  "remote TypeScript symbol references and calls keep both owned file identities",
  async () => {
    if (!host) throw new Error("Set PI_IDE_SSH_SMOKE_HOST to a trusted SSH alias");
    const registry = new SshBackendRegistry([{ id: "smoke", host, workspace: "/tmp" }]);
    const owner = registry.resolve("ssh://smoke/tmp");
    if (!owner) throw new Error("Missing configured owner");
    const created = await owner.backend.execute(
      "mktemp",
      ["-d", "/tmp/.tmp-pi-ide-navigation-live-XXXXXX"],
      "/tmp",
    );
    expect(created.exitCode).toBe(0);
    const directory = created.stdout.toString().trim();
    if (!/^\/tmp\/\.tmp-pi-ide-navigation-live-[A-Za-z0-9]+$/u.test(directory))
      throw new Error("Unexpected fixture path");
    const root = `ssh://smoke${directory}`;
    const files = {
      "note.ts": 'export function greet(): string { return "café"; }\n',
      "reference.ts":
        'import { greet } from "./note";\nexport function caller(): string { return greet(); }\n',
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ["*.ts"],
      }),
    };
    const manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            owned: {
              command: ["/usr/local/bin/typescript-language-server", "--stdio"],
              rootMarkers: ["tsconfig.json"],
              requireRootMarker: true,
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: ["diagnostics"],
              initializationOptions: {
                tsserver: { path: "/usr/local/lib/node_modules/typescript/lib" },
              },
            },
          },
        },
        root,
      ),
      createSshLspWorkspaceOwner(registry),
    );
    try {
      for (const [name, content] of Object.entries(files))
        await owner.backend.write(`${directory}/${name}`, Buffer.from(content), null);
      const hits = await searchSymbols("greet", root, 50, undefined, { include: "*.ts" }, manager);
      expect(hits.hits.map((hit) => hit.source)).toEqual(
        expect.arrayContaining([`${root}/note.ts`, `${root}/reference.ts`]),
      );
      const graph = await readLspSymbolGraph(manager, `${root}/note.ts`, ["greet"], root);
      expect(graph).toContain(`${root}/reference.ts`);
      expect(graph).toContain("caller");
      expect(graph).toContain("Incoming calls: 1");
    } finally {
      await manager.shutdownAll();
      await removeOwnedSources(owner.backend, directory, Object.keys(files));
      expect((await owner.backend.execute("rmdir", [directory], "/tmp")).exitCode).toBe(0);
    }
  },
  60000,
);

test.skipIf(!host)(
  "a remote TypeScript server returns completed diagnostics for its owned document",
  async () => {
    if (!host) throw new Error("Set PI_IDE_SSH_SMOKE_HOST to a trusted SSH alias");
    const registry = new SshBackendRegistry([{ id: "smoke", host, workspace: "/tmp" }]);
    const owner = registry.resolve("ssh://smoke/tmp");
    if (!owner) throw new Error("Missing configured owner");
    const created = await owner.backend.execute(
      "mktemp",
      ["-d", "/tmp/.tmp-pi-ide-lsp-live-XXXXXX"],
      "/tmp",
    );
    const directory = created.stdout.toString().trim();
    expect(created.exitCode).toBe(0);
    if (!/^\/tmp\/\.tmp-pi-ide-lsp-live-[A-Za-z0-9]+$/u.test(directory))
      throw new Error("Unexpected fixture path");
    const root = `ssh://smoke${directory}`;
    const file = `${directory}/note.ts`;
    const content = "export const label: string = 42;\n";
    const client = new LspClient({
      serverId: "typescript-live",
      rootUri: root,
      command: ["/usr/local/bin/typescript-language-server", "--stdio"],
      initOptions: { tsserver: { path: "/usr/local/lib/node_modules/typescript/lib" } },
      timeoutMs: 5_000,
      ownerTransport: createSshLspTransport(registry, root),
    });
    try {
      await owner.backend.write(file, Buffer.from(content), null);
      expect(
        await sshProjectExecutableAvailability(owner.backend, directory, [
          { command: ["/usr/local/bin/typescript-language-server"] },
          { command: ["owned-nonexistent-language-server"] },
        ]),
      ).toEqual([true, false]);
      await client.start();
      expect(client.ready).toBe(true);
      expect(client.pid).toBeNull();
      expect(client.remote?.target).toBe("smoke");
      expect(client.remote?.pid).toBeGreaterThan(0);
      const uri = `${root}/note.ts`;
      client.openDocument(uri, content, "typescript");
      const adapter = completedDiagnosticAdapter(client);
      if (!adapter) throw new Error("Server did not advertise completed diagnostics");
      const diagnostics = await adapter.request(client, uri, new AbortController().signal);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: "2322", line: 1, severity: "error" }),
      );
      const compiler = createLspCompiler((cwd, source) => {
        expect(cwd).toBe("/controller");
        expect(source).toBe(uri);
        return Promise.resolve({
          openFile: () => Promise.resolve({ client, uri, languageId: "typescript" }),
        });
      });
      const compiled = await compiler.compile({ filePath: uri }, { cwd: "/controller" });
      expect(compiled.ok).toBe(false);
      expect(compiled.diagnostics).toContainEqual(
        expect.objectContaining({ code: "2322", line: 1, severity: "error" }),
      );
    } finally {
      await client.shutdown();
      await owner.backend.remove(file, (await owner.backend.read(file)).version);
      expect((await owner.backend.execute("rmdir", [directory], "/tmp")).exitCode).toBe(0);
    }
  },
  45_000,
);
