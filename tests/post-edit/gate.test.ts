import { createTextDocument } from "pi-agent-text";
import { afterEach, expect, test, vi } from "vitest";
import { runIdePostEditGate } from "#src/post-edit/gate.js";
import { registerTools, resetRegistry } from "#src/toolchain/registry.js";
import type { TextPostEditTransaction } from "pi-agent-text-editor/api/post-edit";

function transaction(resourceSource = "/workspace/example.ts"): TextPostEditTransaction {
  return {
    source: resourceSource,
    resourceSource,
    resolvedBy: "filesystem",
    cwd: "/workspace",
    before: createTextDocument(resourceSource, "const n = 1;"),
    requestedAfter: createTextDocument(resourceSource, 'const n: number = "wrong";'),
  };
}
afterEach(resetRegistry);

test.each([
  { ok: true, edits: 0, status: "unchanged" },
  { ok: false, edits: 0, status: "failed" },
])("reports formatter outcome $status", async ({ ok, edits, status }) => {
  registerTools([
    {
      kind: "formatter",
      name: "fixture",
      priority: 1,
      extensions: ["*"],
      detect: async () => true,
      format: async () => ({ ok, edits }),
    },
  ]);
  const result = await runIdePostEditGate(transaction());
  expect(result.formatting).toEqual({ status, formatter: "fixture" });
  expect(result.diffStatuses?.map(({ tone }) => tone) ?? []).toEqual(ok ? ["success"] : []);
});

test.each(["oxfmt", null])("uses the resolved formatter identity %s", async (formatter) => {
  registerTools([
    {
      kind: "formatter",
      name: "extension-wrapper",
      priority: 1,
      extensions: ["*"],
      detect: async () => true,
      format: async () => ({ ok: true, edits: 0, formatter }),
    },
  ]);
  const result = await runIdePostEditGate(transaction());
  expect(result.formatting).toEqual(
    formatter === null ? { status: "unavailable" } : { status: "unchanged", formatter },
  );
  if (formatter === null) expect(result.diffStatuses).toBeUndefined();
});
test("reports formatter exceptions without undoing the edit", async () => {
  registerTools([
    {
      kind: "formatter",
      name: "fixture",
      priority: 1,
      extensions: ["*"],
      detect: async () => true,
      format: async () => {
        throw new Error("formatter failed");
      },
    },
  ]);
  await expect(runIdePostEditGate(transaction())).resolves.toEqual({
    formatting: { status: "failed", formatter: "fixture" },
  });
});

test("formats without detecting or waiting for LSP and lint, and returns no diagnostic hints", async () => {
  const background = vi.fn(() => {
    throw new Error("Analysis must not run in the edit gate");
  });
  const format = vi.fn(async () => ({ ok: true, edits: 1 }));
  registerTools([
    {
      kind: "compiler",
      name: "lsp",
      priority: 1,
      extensions: ["*"],
      detect: background,
      compile: background,
    },
    {
      kind: "linter",
      name: "lint",
      priority: 1,
      extensions: ["*"],
      detect: background,
      lint: background,
    },
    {
      kind: "formatter",
      name: "format",
      priority: 1,
      extensions: ["*"],
      detect: async () => true,
      format,
    },
  ]);
  const result = await runIdePostEditGate(transaction());
  expect(result.formatting).toEqual({ status: "changed", formatter: "format" });
  expect(result.diffStatuses?.map(({ tone }) => tone)).toEqual(["success"]);
  expect(format).toHaveBeenCalledOnce();
  expect(background).not.toHaveBeenCalled();
});

test("an explicitly syntax-only check can skip formatting", async () => {
  const format = vi.fn(async () => ({ ok: true, edits: 1 }));
  registerTools([
    {
      kind: "compiler",
      syntaxOnly: true,
      name: "parser",
      priority: 1,
      extensions: [".ts"],
      detect: async () => true,
      compile: async () => ({
        ok: false,
        diagnostics: [],
        otherDiagnostics: [],
        syntaxErrors: [
          { line: 1, column: 1, severity: "error", code: "parse", message: "Expected expression" },
        ],
      }),
    },
    {
      kind: "formatter",
      name: "format",
      priority: 1,
      extensions: ["*"],
      detect: async () => true,
      format,
    },
  ]);
  await expect(runIdePostEditGate(transaction())).resolves.toEqual({
    formatting: { status: "skipped-syntax" },
  });
  expect(format).not.toHaveBeenCalled();
});

test("non-file edits do not run formatting", async () => {
  const detect = vi.fn(async () => true);
  registerTools([
    {
      kind: "formatter",
      name: "format",
      priority: 1,
      extensions: ["*"],
      detect,
      format: async () => ({ ok: true, edits: 0 }),
    },
  ]);
  await runIdePostEditGate(transaction("memory:example.ts"));
  expect(detect).not.toHaveBeenCalled();
});
