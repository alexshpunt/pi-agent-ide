import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DiagnosticStore } from "#src/core/diagnostic-store.js";
import { createLspDiagnosticSource } from "#src/plugins/pi-agent-ide-lsp/src/diagnostic-source.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import { requestDiagnostics } from "#src/plugins/pi-agent-ide-lsp/src/lsp/diagnostics.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(mode: string, content: string) {
  const root = path.resolve(".agents/tmp/diagnostic-protocol");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "example.ts");
  await writeFile(file, content);
  const manager = LspManager.init(
    LspServerRegistry.fromConfig({
      version: 1,
      servers: {
        fixture: {
          command: [
            process.execPath,
            path.resolve("tests/integration/fixtures/diagnostic-server.mjs"),
            mode,
          ],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
          rootMarkers: [],
          timeoutMs: 1000,
        },
      },
    }),
  );
  cleanup.push(() => manager.shutdownAll());
  const store = new DiagnosticStore([createLspDiagnosticSource(async () => manager)], {
    readWaitMs: 1500,
  });
  cleanup.push(() => store.dispose());
  return { cwd, file, manager, store };
}

test.each(["push", "pull"])(
  "%s checks reject old reports and clear current diagnostics",
  async (mode) => {
    const { cwd, file, store, manager } = await fixture(mode, "broken");
    const result = await store.read(file, { cwd });
    expect(result.results[0]).toMatchObject({
      status: mode === "pull" ? "ready" : "snapshot",
      diagnostics: [{ code: "type", severity: "error" }],
    });
    await writeFile(file, "clean");
    expect((await store.read(file, { cwd })).results[0]).toMatchObject({
      status: mode === "pull" ? "ready" : "snapshot",
      diagnostics: [],
    });
    const opened = await manager.openFile(file, cwd);
    if (!opened) throw new Error("Missing fixture server");
    const direct = await requestDiagnostics(opened.client, opened.uri, opened.languageId);
    expect(direct.syntaxErrors).toEqual([]);
  },
);

test.each(["push"])(
  "later empty %s updates clear cached errors without another check",
  async (mode) => {
    const { cwd, file, store } = await fixture(mode, "broken clear-later");
    expect((await store.read(file, { cwd })).results[0]?.diagnostics).toHaveLength(1);
    await vi.waitFor(async () =>
      expect((await store.read(file, { cwd })).results[0]?.diagnostics).toEqual([]),
    );
  },
);

test("an empty push cannot clear errors from a completed pull report", async () => {
  const { cwd, file, store, manager } = await fixture("pull-push", "broken clear-later");
  expect((await store.read(file, { cwd })).results[0]?.diagnostics).toHaveLength(1);
  const client = await manager.getOrStart(".ts", cwd, "diagnostics");
  if (!client) throw new Error("Missing fixture server");
  const requests = vi.spyOn(client, "sendRequest");
  try {
    await vi.waitFor(() =>
      expect(requests).toHaveBeenCalledWith(
        "textDocument/diagnostic",
        expect.anything(),
        expect.anything(),
      ),
    );
    expect((await store.read(file, { cwd })).results[0]).toMatchObject({
      status: "ready",
      diagnostics: [{ code: "type" }],
    });
  } finally {
    requests.mockRestore();
  }
});

test("push without a document version is explicitly unverified", async () => {
  const { cwd, file, store } = await fixture("unversioned", "broken");
  const result = (await store.read(file, { cwd })).results[0];
  expect(result.status).toBe("snapshot");
  expect(result.reason).toContain("omitted the document version");
  expect((await store.takeNotifications(cwd)).join()).toContain("snapshot; completion unknown");
});

test("a server that ignores shutdown cannot hold the session open forever", async () => {
  const { cwd, file, manager } = await fixture("shutdown-stuck", "broken");
  const opened = await manager.openFile(file, cwd);
  if (!opened) throw new Error("Missing fixture server");
  await manager.shutdownAll();
  expect(opened.client.ready).toBe(false);
}, 3000);

test("a silent push server times out without reporting a clean file", async () => {
  const { cwd, file, store } = await fixture("silent", "broken");
  expect((await store.read(file, { cwd })).results[0]?.status).toBe("unavailable");
});

test("superseding a push wait cancels it and isolates the next document version", async () => {
  const { cwd, file, manager } = await fixture("silent", "broken");
  const opened = await manager.openFile(file, cwd);
  if (!opened) throw new Error("Missing fixture server");
  const controller = new AbortController();
  const request = requestDiagnostics(opened.client, opened.uri, opened.languageId, {
    signal: controller.signal,
  });
  const rejected = expect(request).rejects.toThrow("Superseded");
  controller.abort(new Error("Superseded"));
  await rejected;
  expect(opened.client.hasActiveDiagnosticRequest(opened.uri)).toBe(false);
});
