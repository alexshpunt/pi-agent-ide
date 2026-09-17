import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyTextChanges } from "#src/core/text-change-engine.js";
import { ApplyUndoStore } from "#src/core/apply/apply-undo-store.js";
import type { TextEditorCore } from "#src/core/text-editor-core.js";
import {
  executeEditorTransaction,
  type EditorSnapshot,
  type TransactionEditor,
} from "#src/core/apply/transaction.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function filesystemEditor(): TransactionEditor & Pick<TextEditorCore, "restoreApplyUndo"> {
  const undo = new ApplyUndoStore();
  return {
    async editTexts(sources, _context, operation) {
      const texts = new Map<string, string>();
      for (const source of sources) {
        try {
          texts.set(source.source, await readFile(source.source, "utf8"));
        } catch (error) {
          if (!source.allowReadFailure) throw error;
        }
      }
      try {
        const planned = await operation(texts, async () => {
          throw new Error("anchors unavailable");
        });
        for (const [source, changes] of planned.changes) {
          const before = texts.get(source) ?? "";
          await writeFile(source, applyTextChanges(before, changes, !texts.has(source)).content);
        }
        return { kind: "completed", resources: [], result: planned.result };
      } catch (cause) {
        return {
          kind: "failed",
          failure: {
            code: "WRITE_FAILED",
            source: sources[0]?.source ?? "unknown",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          },
          completed: [],
        };
      }
    },
    async postProcessFile() {},
    recordApplyUndo: (before) => undo.record(before),
    restoreApplyUndo: (transaction) => undo.restore(transaction),
  };
}

async function fixture(files: Readonly<Record<string, string>> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "apply-transaction-"));
  roots.push(cwd);
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(cwd, name), content);
  const core = filesystemEditor();
  const run = (snapshots: readonly EditorSnapshot[], operations: readonly unknown[]) =>
    executeEditorTransaction(core, { snapshots, operations }, new AbortController().signal, {
      cwd,
    });
  return { cwd, core, run };
}

function snapshot(cwd: string, id: string, name: string, content: string): EditorSnapshot {
  return { id, source: path.join(cwd, name), content };
}

function replace(document: string, from: number, to: number, text: string, insert: string) {
  return { kind: "replace", selection: { document, from, to, text }, text: insert };
}

test("an invalid selection fails only its operation", async () => {
  const { cwd, run } = await fixture({ "a.txt": "abc", "b.txt": "xyz" });
  const outcome = await run(
    [snapshot(cwd, "a", "a.txt", "abc"), snapshot(cwd, "b", "b.txt", "xyz")],
    [replace("missing", 0, 1, "a", "A"), replace("b", 0, 1, "x", "X")],
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["failed", "applied"]);
  expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("Xyz");
});

test("a stale snapshot fails only edits that use it", async () => {
  const { cwd, run } = await fixture({ "stale.txt": "new", "fresh.txt": "fresh" });
  const outcome = await run(
    [snapshot(cwd, "stale", "stale.txt", "old"), snapshot(cwd, "fresh", "fresh.txt", "fresh")],
    [replace("stale", 0, 3, "old", "OLD"), replace("fresh", 0, 5, "fresh", "FRESH")],
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["failed", "applied"]);
  expect(outcome.operations?.[0]?.error?.code).toBe("STALE_SNAPSHOT");
});

test("the first overlapping edit wins and later snapshot offsets stay stable", async () => {
  const { cwd, run } = await fixture({ "note.txt": "one two three" });
  const outcome = await run(
    [snapshot(cwd, "note", "note.txt", "one two three")],
    [
      replace("note", 0, 3, "one", "ONE-LONG"),
      replace("note", 0, 7, "one two", "blocked"),
      replace("note", 8, 13, "three", "THREE"),
    ],
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["applied", "failed", "applied"]);
  expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ONE-LONG two THREE");
});

test("same-position inserts preserve staging order", async () => {
  const { cwd, run } = await fixture({ "note.txt": "ab" });
  const outcome = await run(
    [snapshot(cwd, "note", "note.txt", "ab")],
    [replace("note", 1, 1, "", "first"), replace("note", 1, 1, "", "second")],
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["applied", "applied"]);
  expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("afirstsecondb");
});

test("many replacements write one final file state", async () => {
  const original = Array.from({ length: 1_000 }, (_, index) => `legacy-${index}\n`).join("");
  const { cwd, core } = await fixture({ "large.txt": original });
  let writes = 0;
  const editor: TransactionEditor = {
    ...core,
    async editTexts(...arguments_) {
      writes += 1;
      return core.editTexts(...arguments_);
    },
  };
  const operations = Array.from({ length: 1_000 }, (_, index) => {
    const text = `legacy-${index}`;
    const from = original.indexOf(text);
    return replace("large", from, from + text.length, text, `stable-${index}`);
  });

  const outcome = await executeEditorTransaction(
    editor,
    { snapshots: [snapshot(cwd, "large", "large.txt", original)], operations },
    new AbortController().signal,
    { cwd },
  );

  expect(outcome.operations).toHaveLength(1_000);
  expect(outcome.operations?.every(({ status }) => status === "applied")).toBe(true);
  expect(writes).toBe(1);
  expect(await readFile(path.join(cwd, "large.txt"), "utf8")).toBe(
    original.replaceAll("legacy-", "stable-"),
  );
});
test("a failed file operation leaves known state for later dependent work", async () => {
  const { cwd, run } = await fixture();
  const outcome = await run(
    [],
    [
      { kind: "delete", path: "missing.txt" },
      { kind: "create", path: "missing.txt", content: "created" },
    ],
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["failed", "applied"]);
  expect(await readFile(path.join(cwd, "missing.txt"), "utf8")).toBe("created");
});

test("an execution failure rolls back only that operation", async () => {
  const { cwd, core } = await fixture({ "source.txt": "source", "independent.txt": "old" });
  const editor: TransactionEditor = {
    editTexts: core.editTexts,
    recordApplyUndo: core.recordApplyUndo,
    async postProcessFile() {
      throw new Error("injected post-process failure");
    },
  };
  const outcome = await executeEditorTransaction(
    editor,
    {
      snapshots: [snapshot(cwd, "independent", "independent.txt", "old")],
      operations: [
        { kind: "copy", path: "source.txt", target: "copy.txt" },
        replace("independent", 0, 3, "old", "new"),
      ],
    },
    new AbortController().signal,
    { cwd },
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual(["failed", "applied"]);
  await expect(readFile(path.join(cwd, "copy.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(cwd, "independent.txt"), "utf8")).toBe("new");
});

test("incomplete rollback blocks dependent work but allows independent work", async () => {
  const { cwd, core } = await fixture({ "source.txt": "source", "other.txt": "old" });
  const editor: TransactionEditor = {
    editTexts: core.editTexts,
    recordApplyUndo: core.recordApplyUndo,
    async postProcessFile() {
      throw new Error("injected execution failure");
    },
  };
  const copy = path.join(cwd, "copy.txt");
  const outcome = await executeEditorTransaction(
    editor,
    {
      snapshots: [snapshot(cwd, "other", "other.txt", "old")],
      operations: [
        { kind: "copy", path: "source.txt", target: "copy.txt" },
        { kind: "delete", path: "copy.txt" },
        replace("other", 0, 3, "old", "new"),
      ],
    },
    new AbortController().signal,
    { cwd },
    {
      async restorePath(state) {
        if (state.path === copy) throw new Error("injected rollback failure");
        if (state.existed) await writeFile(state.path, state.bytes ?? new Uint8Array());
        else await rm(state.path, { force: true });
      },
    },
  );
  expect(outcome.operations?.map(({ status }) => status)).toEqual([
    "unknown",
    "blocked",
    "applied",
  ]);
  expect(outcome.effect).toBe("unknown");
  expect(await readFile(path.join(cwd, "other.txt"), "utf8")).toBe("new");
});

test("one receipt restores all successful effects and all-failed calls have none", async () => {
  const { cwd, core, run } = await fixture({ "a.txt": "a" });
  const applied = await run(
    [snapshot(cwd, "a", "a.txt", "a")],
    [replace("a", 0, 1, "a", "A"), { kind: "create", path: "b.txt", content: "b" }],
  );
  expect(applied.transaction).toMatch(/^APPLY#/u);
  await core.restoreApplyUndo(applied.transaction ?? "");
  expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("a");
  await expect(readFile(path.join(cwd, "b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  const failed = await run([], [{ kind: "delete", path: "missing.txt" }]);
  expect(failed.transaction).toBeUndefined();
});

test("an empty selection is a warning rather than an applied operation", async () => {
  const { cwd, run } = await fixture({ "note.txt": "unchanged" });
  const outcome = await run(
    [snapshot(cwd, "note", "note.txt", "unchanged")],
    [{ kind: "warning", document: "note", query: "missing" }],
  );
  expect(outcome).toMatchObject({ ok: false, effect: "not-applied" });
  expect(outcome.transaction).toBeUndefined();
  expect(outcome.operations).toMatchObject([{ status: "warning", effect: "not-applied" }]);
});

test("a text move is atomic when one source deletion conflicts", async () => {
  const { cwd, run } = await fixture({ "source.txt": "a b", "target.txt": "slot" });
  const outcome = await run(
    [snapshot(cwd, "source", "source.txt", "a b"), snapshot(cwd, "target", "target.txt", "slot")],
    [
      {
        kind: "text-move",
        sources: [
          { document: "source", from: 0, to: 1, text: "a" },
          { document: "source", from: 0, to: 3, text: "a b" },
        ],
        destinations: [{ document: "target", from: 0, to: 4, text: "slot" }],
        text: "aa b",
      },
    ],
  );
  expect(outcome.operations).toMatchObject([{ status: "failed", effect: "not-applied" }]);
  expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("a b");
  expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("slot");
});

test("text copy concatenates ordered sources and replicates every destination", async () => {
  const { cwd, run } = await fixture({ "source.txt": "a-b", "target.txt": "x y" });
  const outcome = await run(
    [snapshot(cwd, "source", "source.txt", "a-b"), snapshot(cwd, "target", "target.txt", "x y")],
    [
      {
        kind: "text-copy",
        sources: [
          { document: "source", from: 0, to: 1, text: "a" },
          { document: "source", from: 2, to: 3, text: "b" },
        ],
        destinations: [
          { document: "target", from: 0, to: 1, text: "x" },
          { document: "target", from: 2, to: 3, text: "y" },
        ],
        text: "ab",
      },
    ],
  );
  expect(outcome.operations).toMatchObject([{ status: "applied", effect: "applied" }]);
  expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("a-b");
  expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("ab ab");
});

test("text move concatenates cross-file sources and removes them atomically", async () => {
  const { cwd, run } = await fixture({ "source.txt": "a-b", "target.txt": "x y" });
  const outcome = await run(
    [snapshot(cwd, "source", "source.txt", "a-b"), snapshot(cwd, "target", "target.txt", "x y")],
    [
      {
        kind: "text-move",
        sources: [
          { document: "source", from: 0, to: 1, text: "a" },
          { document: "source", from: 2, to: 3, text: "b" },
        ],
        destinations: [
          { document: "target", from: 0, to: 1, text: "x" },
          { document: "target", from: 2, to: 3, text: "y" },
        ],
        text: "ab",
      },
    ],
  );
  expect(outcome.operations).toMatchObject([{ status: "applied" }]);
  expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("-");
  expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("ab ab");
});

test("linewise text move inserts at EOF without fusing lines", async () => {
  const sourceContent = "keep\n// BEGIN\nbody\n// END\nafter\n";
  const targetContent = "target\nlast";
  const { cwd, run } = await fixture({
    "source.txt": sourceContent,
    "target.txt": targetContent,
  });
  const outcome = await run(
    [
      snapshot(cwd, "source", "source.txt", sourceContent),
      snapshot(cwd, "target", "target.txt", targetContent),
    ],
    [
      {
        kind: "text-move",
        sources: [
          {
            document: "source",
            from: 5,
            to: 26,
            text: "// BEGIN\nbody\n// END\n",
            linewise: true,
          },
        ],
        destinations: [{ document: "target", from: 11, to: 11, text: "", linewise: true }],
        text: "// BEGIN\nbody\n// END\n",
      },
    ],
  );
  expect(outcome.operations).toMatchObject([{ status: "applied" }]);
  expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("keep\nafter\n");
  expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe(
    "target\nlast\n// BEGIN\nbody\n// END\n",
  );
});

test("same-file text move keeps original offsets", async () => {
  const { cwd, run } = await fixture({ "note.txt": "a b c" });
  const outcome = await run(
    [snapshot(cwd, "note", "note.txt", "a b c")],
    [
      {
        kind: "text-move",
        sources: [{ document: "note", from: 0, to: 1, text: "a" }],
        destinations: [{ document: "note", from: 4, to: 5, text: "c" }],
        text: "a",
      },
    ],
  );
  expect(outcome.operations).toMatchObject([{ status: "applied" }]);
  expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe(" b a");
});

test("linewise replacements preserve the selected trailing line break", async () => {
  const { cwd, run } = await fixture({ "note.txt": "before\nnext\n" });
  const outcome = await run(
    [snapshot(cwd, "note", "note.txt", "before\nnext\n")],
    [
      {
        kind: "replace",
        selection: { document: "note", from: 0, to: 7, text: "before\n", linewise: true },
        text: "after",
      },
    ],
  );
  expect(outcome.ok).toBe(true);
  expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("after\nnext\n");
});

test("a malformed request is rejected as a whole", async () => {
  const { run } = await fixture();
  await expect(run([], [{ kind: "unknown" }])).rejects.toMatchObject({
    code: "INVALID_TRANSACTION",
  });
});
