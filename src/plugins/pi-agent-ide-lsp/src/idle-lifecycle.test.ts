import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createLspDiagnosticSource } from "./diagnostic-source.js";
import { withLspDocuments } from "./lsp/document-leases.js";
import { LspManager } from "./lsp/manager.js";
import { LspServerRegistry } from "./lsp/registry.js";

import type { LspClient } from "./lsp/client.js";

const directories: string[] = [];
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Status {
  readonly open: readonly string[];
  readonly events: readonly (readonly [string, string])[];
  readonly pid: number;
}

async function fixture(idleTimeoutMs?: number): Promise<{ manager: LspManager; cwd: string }> {
  const root = path.resolve(".agents/tmp/lsp-idle-lifecycle");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "first.fx"), "first\n");
  await writeFile(path.join(cwd, "second.fx"), "second\n");
  const server = path.resolve(
    "src/plugins/pi-agent-ide-lsp/src/lsp/test/fixtures/document-lifecycle-server.mjs",
  );
  const registry = LspServerRegistry.fromConfig(
    {
      version: 1,
      servers: {
        fixture: {
          command: [process.execPath, server],
          rootMarkers: [],
          languages: { fixture: { extensions: [".fx"] } },
          capabilities: ["diagnostics"],
        },
      },
    },
    cwd,
  );
  return {
    manager: LspManager.init(
      registry,
      undefined,
      idleTimeoutMs === undefined ? {} : { idleTimeoutMs },
    ),
    cwd,
  };
}

async function client(manager: LspManager, cwd: string): Promise<LspClient> {
  const started = await manager.getOrStart(path.join(cwd, "first.fx"), cwd, "symbols");
  if (started === null) throw new Error("Fixture server did not start");
  return started;
}

const status = (target: LspClient) => target.sendRequest<Status>("lifecycle/status", {});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("closes documents after the operation that opened them, unless another still uses them", async () => {
  const { manager, cwd } = await fixture();
  const first = path.join(cwd, "first.fx");
  let finishOuter!: () => void;
  const outerHeld = new Promise<void>((resolve) => (finishOuter = resolve));
  let outerOpened!: () => void;
  const opened = new Promise<void>((resolve) => (outerOpened = resolve));

  const outer = withLspDocuments(async () => {
    await manager.openFile(first, cwd, "symbols");
    outerOpened();
    await outerHeld;
  });
  await opened;
  await withLspDocuments(async () => {
    await manager.openFile(first, cwd, "symbols");
    await manager.openFile(path.join(cwd, "second.fx"), cwd, "symbols");
  });

  const server = await client(manager, cwd);
  expect((await status(server)).open).toEqual([server.toUri(first)]);
  finishOuter();
  await outer;
  expect((await status(server)).open).toEqual([]);
  expect(server.documentVersion(server.toUri(first))).toBeUndefined();
});

test("a diagnostic check closes its document and ignores the server's close report", async () => {
  const { manager, cwd } = await fixture();
  const file = path.join(cwd, "first.fx");
  const publish = vi.fn();
  const source = createLspDiagnosticSource(async () => manager);

  const report = await source.diagnose(file, {
    cwd,
    content: "first\n",
    signal: new AbortController().signal,
    publish,
  });

  expect(report).toMatchObject({ status: "snapshot", diagnostics: [{ message: "fixture error" }] });
  const server = await client(manager, cwd);
  const { open, events } = await status(server);
  expect(open).toEqual([]);
  expect(events).toEqual([
    ["open", server.toUri(file)],
    ["close", server.toUri(file)],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(publish).not.toHaveBeenCalled();
});

test("stops an idle language server and restarts it for the next request", async () => {
  const { manager, cwd } = await fixture(300);
  const first = await client(manager, cwd);
  const { pid } = await status(first);

  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
  expect(manager.clientCount).toBe(0);

  const result = await withLspDocuments(async () => {
    const opened = await manager.openFile(path.join(cwd, "first.fx"), cwd, "symbols");
    if (opened === null) throw new Error("Fixture server did not restart");
    return {
      symbols: await opened.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: opened.uri },
      }),
      status: await status(opened.client),
    };
  });
  expect(result.symbols).toEqual([]);
  expect(result.status.pid).not.toBe(pid);
  expect(result.status.open).toEqual([expect.stringMatching(/first\.fx$/u)]);
});

test("does not stop a language server during a request or an open operation", async () => {
  const { manager, cwd } = await fixture(200);
  const server = await client(manager, cwd);
  const { pid } = await status(server);

  await expect(server.sendRequest("lifecycle/slow", { ms: 600 })).resolves.toBe("slow done");
  expect(alive(pid)).toBe(true);

  await withLspDocuments(async () => {
    await manager.openFile(path.join(cwd, "first.fx"), cwd, "symbols");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(alive(pid)).toBe(true);
  });
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
});

test("session shutdown stops idle timers with their servers", async () => {
  const { manager, cwd } = await fixture(200);
  const errors = vi.spyOn(console, "error");
  const { pid } = await status(await client(manager, cwd));
  await manager.shutdownAll();
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000, interval: 50 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(manager.clientCount).toBe(0);
  expect(errors).not.toHaveBeenCalled();
});
