import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { requiredValue } from "pi-agent-invariant";
import { afterEach, expect, test, vi } from "vitest";
import { DiagnosticStore } from "./diagnostic-store.js";
import type {
  IdeDiagnosticContext,
  IdeDiagnosticReport,
  IdeDiagnosticSource,
} from "#src/api/plugin-protocol.js";

const clean: IdeDiagnosticReport = { status: "ready", diagnostics: [] };
const broken: IdeDiagnosticReport = {
  status: "ready",
  diagnostics: [
    { line: 1, column: 1, severity: "error", code: "type", message: "Private diagnostic detail" },
  ],
};
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(sources: IdeDiagnosticSource[], options = {}) {
  const root = path.resolve(".agents/tmp/diagnostic-store-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "example.ts");
  await writeFile(file, "A");
  const store = new DiagnosticStore(sources, { readWaitMs: 5, ...options });
  cleanup.push(() => store.dispose());
  return { cwd, file, store };
}

function controlled(id: string) {
  const calls: { context: IdeDiagnosticContext; finish: (report: IdeDiagnosticReport) => void }[] =
    [];
  const source: IdeDiagnosticSource = {
    id,
    diagnose: (_file, context) =>
      new Promise((finish) => {
        calls.push({ context, finish });
      }),
  };
  return { source, calls };
}

test("edits supersede old jobs; independent sources report partial readiness without changing text", async () => {
  const lsp = controlled("lsp");
  const lint = controlled("lint");
  const { store, cwd, file } = await fixture([lsp.source, lint.source]);
  store.schedule(file, "A", { cwd });
  await vi.waitFor(() => expect(lsp.calls).toHaveLength(1));
  await writeFile(file, "B");
  store.schedule(file, "B", { cwd });
  await vi.waitFor(() => expect(lint.calls).toHaveLength(2));
  expect(requiredValue(lsp.calls[0]).context.signal.aborted).toBe(true);
  requiredValue(lsp.calls[0]).finish(broken);
  requiredValue(lint.calls[0]).finish(broken);
  requiredValue(lint.calls[1]).finish(clean);
  const snapshot = await store.read(file, { cwd });
  expect(snapshot.content).toBe("B");
  expect(snapshot.results).toEqual([
    { source: "lsp", status: "pending", diagnostics: [] },
    { source: "lint", ...clean },
  ]);
  const pending = await store.takeNotifications(cwd);
  expect(pending.join()).toContain("lsp pending");
  expect(pending.join()).not.toContain("1 error");
  requiredValue(lsp.calls[1]).finish(broken);
  await vi.waitFor(async () =>
    expect((await store.read(file, { cwd })).results[0]).toEqual({ source: "lsp", ...broken }),
  );
  expect((await store.takeNotifications(cwd)).join()).toContain("lsp 1 error");
  expect(await store.takeNotifications(cwd)).toEqual([]);
  requiredValue(lsp.calls[1]).context.publish(clean);
  await vi.waitFor(async () =>
    expect((await store.read(file, { cwd })).results[0]).toEqual({ source: "lsp", ...clean }),
  );
  const cleared = (await store.takeNotifications(cwd)).join();
  expect(cleared).toContain("lsp 0 error");
  expect(cleared).not.toContain("Private diagnostic detail");
  expect(await readFile(file, "utf8")).toBe("B");
});

test("reads reuse current results and detect changes outside the IDE", async () => {
  const diagnose = vi.fn(async () => clean);
  const { store, cwd, file } = await fixture([{ id: "lint", diagnose }]);
  await store.read(file, { cwd });
  await store.read(file, { cwd });
  expect(diagnose).toHaveBeenCalledTimes(1);
  await writeFile(file, "external change");
  expect((await store.read(file, { cwd })).content).toBe("external change");
  expect(diagnose).toHaveBeenCalledTimes(2);
});

test("failed and timed-out sources are unavailable rather than clean", async () => {
  const stuck = controlled("stuck");
  const { store, cwd, file } = await fixture(
    [
      stuck.source,
      {
        id: "failed",
        diagnose: async () => {
          throw new Error("Provider failed");
        },
      },
      { id: "ready", diagnose: async () => broken },
    ],
    { checkTimeoutMs: 20 },
  );
  await vi.waitFor(async () => {
    const results = (await store.read(file, { cwd })).results;
    expect(results[0]?.status).toBe("unavailable");
    expect(results[1]?.status).toBe("unavailable");
    expect(results[2]?.diagnostics).toHaveLength(1);
  });
  expect(requiredValue(stuck.calls[0]).context.signal.aborted).toBe(true);
  requiredValue(stuck.calls[0]).context.publish(clean);
  expect((await store.read(file, { cwd })).results[0]?.status).toBe("unavailable");
});

test("shutdown invalidates late publications and pending notifications", async () => {
  const provider = controlled("lsp");
  const { store, cwd, file } = await fixture([provider.source]);
  store.schedule(file, "A", { cwd });
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  store.dispose();
  requiredValue(provider.calls[0]).finish(broken);
  requiredValue(provider.calls[0]).context.publish(broken);
  expect(await store.takeNotifications(cwd)).toEqual([]);
  await expect(store.read(file, { cwd })).rejects.toThrow("session has ended");
});

test("workspace identities isolate the same relative file name", async () => {
  const provider = controlled("lsp");
  const { store, cwd, file } = await fixture([provider.source]);
  const otherCwd = path.join(cwd, "other");
  await mkdir(otherCwd);
  const other = path.join(otherCwd, "example.ts");
  await writeFile(other, "A");
  store.schedule(file, "A", { cwd });
  store.schedule(other, "A", { cwd: otherCwd });
  await vi.waitFor(() => expect(provider.calls).toHaveLength(2));
  expect(await store.takeNotifications(cwd)).toHaveLength(1);
  expect(await store.takeNotifications(otherCwd)).toHaveLength(1);
});
