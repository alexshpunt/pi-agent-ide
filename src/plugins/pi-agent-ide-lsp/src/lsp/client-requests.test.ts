import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { URI } from "vscode-uri";
import { LspClient } from "./client.js";
import type { WatchedFileChange } from "./file-watchers.js";

test("includes bounded native stderr when a language server cannot initialize", async () => {
  const client = new LspClient({
    serverId: "broken",
    rootUri: URI.file(process.cwd()).toString(),
    command: [
      process.execPath,
      "-e",
      'process.stderr.write("x".repeat(100000) + "MATRIX_STARTUP_FAILURE", () => process.exit(1))',
    ],
  });
  try {
    await expect(client.start()).rejects.toThrow("MATRIX_STARTUP_FAILURE");
  } finally {
    await client.shutdown();
  }
});

interface ServerStatus {
  registered: boolean;

  saves: { textDocument: { uri: string }; text?: string }[];

  initializeFolders: { uri: string; name: string }[];
  requestedFolders: { uri: string; name: string }[];
  configuration?: unknown[];
  changes: WatchedFileChange[];
}

test("answers server configuration and dynamic watcher requests over real stdio", async () => {
  const parent = path.resolve(".agents/tmp/lsp-client-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "requests-"));
  const client = new LspClient({
    serverId: "matrix",
    rootUri: URI.file(root).toString(),
    command: [
      process.execPath,
      path.resolve("src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/client-server.mjs"),
    ],
    settings: { matrix: { enabled: true } },
  });
  const status = () => client.sendRequest<ServerStatus>("matrix/status", {});
  try {
    await client.start();
    await expect.poll(async () => (await status()).registered).toBe(true);
    expect((await status()).configuration).toEqual([true, null]);

    const folders = [{ uri: URI.file(root).toString(), name: path.basename(root) }];
    expect((await status()).initializeFolders).toEqual(folders);
    expect((await status()).requestedFolders).toEqual(folders);
    const file = path.join(root, "input.matrix");
    await writeFile(file, "value");
    await expect
      .poll(async () =>
        (await status()).changes.some(
          (event) => event.uri === URI.file(file).toString() && event.type === 1,
        ),
      )
      .toBe(true);
    await client.sendRequest("matrix/unregister", {});

    const uri = URI.file(file).toString();
    client.syncDocument(uri, "value", "matrix");
    await expect.poll(() => client.diagnosticPublication(uri)?.version).toBe(1);
    const publication = client.diagnosticPublication(uri);
    client.syncDocument(uri, "value", "matrix");
    expect(client.documentVersion(uri)).toBe(1);
    expect(client.diagnosticPublication(uri)).toBe(publication);
    expect((await status()).saves).toEqual([]);
    client.syncDocument(uri, "changed", "matrix", true);
    client.syncDocument(uri, "changed", "matrix", true);
    expect((await status()).saves).toEqual([{ textDocument: { uri }, text: "changed" }]);
    expect(client.documentVersion(uri)).toBe(2);
    expect(client.diagnosticPublication(uri)).toBeUndefined();
    client.closeDocument(uri);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
