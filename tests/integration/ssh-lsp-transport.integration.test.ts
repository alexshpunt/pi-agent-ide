import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { LspClient } from "#src/plugins/pi-agent-ide-lsp/src/lsp/client.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { createLspCompiler } from "#src/plugins/pi-agent-ide-lsp/src/lsp/lsp-compiler.js";

test("SSH language server stdio maps owned URIs without mapping source text or local PIDs", async () => {
  const fixture = await startSshFixture();
  let client: LspClient | undefined;
  try {
    const root = `ssh://fixture${fixture.workspace}`;
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const owner = registry.resolve(root);
    if (!owner) throw new Error("Missing fixture owner");
    const script = `${fixture.workspace}/server.py`;
    await owner.backend.write(
      script,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    const executable = `${fixture.workspace}/.venv/bin/owned-language-server`;
    await owner.backend.write(
      executable,
      Buffer.from(`#!/bin/sh\nexec python3 "${script}"\n`),
      null,
    );
    expect(
      (await owner.backend.execute("chmod", ["+x", executable], fixture.workspace)).exitCode,
    ).toBe(0);
    client = new LspClient({
      serverId: "owned",
      rootUri: root,
      command: ["owned-language-server"],
      env: { LSP_OWNER_TEST: "remote only" },
      ownerTransport: createSshLspTransport(registry, root),
    });
    await client.start();
    expect(client.pid).toBeNull();
    const status = await client.sendRequest<{
      receivedRoot: string;
      clientPid: number | null;
      serverPid: number;
      environment: string;
      watching: { dynamicRegistration: boolean };
    }>("matrix/status", {});
    expect(status.receivedRoot).toBe(pathToFileURL(fixture.workspace).href);
    expect(status.clientPid).toBeNull();
    expect(client.remote).toEqual({ target: "fixture", pid: status.serverPid });
    expect(status.environment).toBe("remote only");
    expect(status.watching.dynamicRegistration).toBe(true);
    const uri = client.toUri("café #1.ts");
    const wireUri = pathToFileURL(`${fixture.workspace}/café #1.ts`).href;
    expect(
      await client.sendRequest("matrix/echo", {
        textDocument: { uri },
        text: "ssh://fixture/literal/source/text",
      }),
    ).toEqual({ uri, receivedUri: wireUri, text: "ssh://fixture/literal/source/text" });
    client.openDocument(uri, "file:///literal/source/text", "typescript");
    await expect.poll(() => client?.diagnosticPublication(uri)?.version).toBe(1);
    const edits = await client.sendRequest<{ changes: Record<string, { newText: string }[]> }>(
      "matrix/edit",
      { textDocument: { uri } },
    );
    expect(Object.keys(edits.changes)).toEqual([uri]);
    expect(edits.changes[uri]?.[0]?.newText).toBe("file:///literal/source/text");
    await expect(
      client.sendRequest("matrix/echo", {
        textDocument: { uri: "ssh://other/tmp/input.ts" },
        text: "keep",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    await client.restart();
    const next = await client.sendRequest<{ serverPid: number }>("matrix/status", {});
    expect(next.serverPid).not.toBe(status.serverPid);
    expect(
      (await owner.backend.execute("kill", ["-0", String(status.serverPid)], fixture.workspace))
        .exitCode,
    ).not.toBe(0);
    await client.shutdown();
    const note = `${root}/src/note.ts`;
    await owner.backend.write(`${fixture.workspace}/project.json`, Buffer.from("{}"), null);
    await owner.backend.write(
      `${fixture.workspace}/src/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    const servers = LspServerRegistry.fromConfig(
      {
        version: 1,
        servers: {
          owned: {
            command: ["python3", "{project}/server.py"],
            rootMarkers: ["project.json"],
            requireRootMarker: true,
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      },
      root,
    );
    const manager = LspManager.init(servers, createSshLspWorkspaceOwner(registry));
    try {
      const opened = await manager.openFile(note, root, "symbols");
      expect(opened?.uri).toBe(note);
      await expect.poll(() => opened?.client.diagnosticPublication(note)?.version).toBe(1);
      expect(await manager.getWorkspaceClients(root)).toEqual([opened?.client]);
      const compiler = createLspCompiler((cwd, source) => {
        expect(cwd).toBe("/controller");
        expect(source).toBe(note);
        return Promise.resolve(manager);
      });
      await expect(compiler.compile({ filePath: note }, { cwd: "/controller" })).rejects.toThrow(
        "Language server diagnostics are a snapshot, not a completed report",
      );
      expect(opened?.client.documentVersion(note)).toBe(1);
    } finally {
      await LspManager.resetForTest();
    }
  } finally {
    await client?.shutdown();
    await fixture.stop();
  }
}, 60_000);
