import { expect, test } from "vitest";
import { executeApplySource, serializeApplyError } from "#src/core/apply/runtime.js";

function snapshot(id: string, content: string) {
  return { id, source: `/tmp/${id}.txt`, content, lines: [] };
}

test("Apply exposes guarded editor globals and hides raw mutation helpers", async () => {
  const calls: string[] = [];
  await executeApplySource(
    `for (const name of ["write", "editBatch", "replace", "insert", "remove", "copy", "move", "delete_file", "copy_file", "move_file"]) {
      if (typeof globalThis[name] !== "undefined") throw new Error(name + " should be hidden");
    }
    if (typeof open !== "function" || typeof apply !== "function") throw new Error("editor missing");
    read({path: "note.txt"});`,
    {
      async execute(operation) {
        calls.push(operation);
        return null;
      },
      async result() {},
    },
  );
  expect(calls).toEqual(["read"]);
});

test("editor stages stable selections from several files and commits once", async () => {
  const requests: unknown[] = [];
  const output: unknown[] = [];
  let opened = 0;
  await executeApplySource(
    `const first = open("first.txt");
     const second = open("second.txt");
     first.replace(first.find("old"), "new");
     second.replaceAll("x", "y");
     result(apply());`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return opened++ === 0 ? snapshot("first", "old value") : snapshot("second", "x x");
        if (operation === "editorApply") {
          requests.push(arguments_);
          return {
            operation: "apply",
            ok: true,
            effect: "applied",
            files: [],
            completed: ["first", "second"],
            errors: [],
          };
        }
        throw new Error(`Unexpected ${operation}`);
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    snapshots: [{ content: "old value" }, { content: "x x" }],
    operations: [
      { kind: "replace", selection: { from: 0, to: 3, text: "old" }, text: "new" },
      { kind: "replace", selection: { from: 0, to: 1, text: "x" }, text: "y" },
      { kind: "replace", selection: { from: 2, to: 3, text: "x" }, text: "y" },
    ],
  });
  expect(output).toHaveLength(1);
});

test("missing and ambiguous matches fail before the host receives a transaction", async () => {
  for (const content of ["none", "same same"]) {
    const calls: string[] = [];
    await expect(
      executeApplySource(
        'const file = open("note.txt"); file.replace(file.find("same"), "new"); apply();',
        {
          async execute(operation) {
            calls.push(operation);
            if (operation === "editorOpen") return snapshot("note", content);
            return null;
          },
          async result() {},
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toEqual(["editorOpen"]);
  }
});

test("staged operations without apply are reported and do not reach the mutation host", async () => {
  const calls: string[] = [];
  const output: unknown[] = [];
  await executeApplySource('createFile("new.txt", "content");', {
    async execute(operation) {
      calls.push(operation);
      return null;
    },
    async result(value) {
      output.push(value);
    },
  });
  expect(calls).toEqual([]);
  expect(output).toEqual([
    {
      kind: "uncommitted-transaction",
      staged: 1,
      message: "Staged changes were not applied; call apply().",
    },
  ]);
});

test("a script can commit several fresh transactions", async () => {
  const calls: string[] = [];
  await executeApplySource(
    'createFile("one.txt", "1"); apply(); createFile("two.txt", "2"); apply();',
    {
      async execute(operation) {
        calls.push(operation);
        return {
          operation: "apply",
          ok: true,
          effect: "applied",
          files: [],
          completed: [],
          errors: [],
        };
      },
      async result() {},
    },
  );
  expect(calls).toEqual(["editorApply", "editorApply"]);
});

test("operation errors retain structured rollback data inside the guest", async () => {
  const output: unknown[] = [];
  await executeApplySource(
    'createFile("one.txt", "1"); try { apply(); } catch (error) { result({code: error.code, details: error.details}); }',
    {
      async execute() {
        throw Object.assign(new Error("failed"), {
          code: "TRANSACTION_FAILED",
          details: { effect: "rolled-back" },
        });
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(output).toEqual([
    { code: "TRANSACTION_FAILED", details: { effect: "rolled-back" } },
    {
      kind: "uncommitted-transaction",
      staged: 1,
      message: "Staged changes were not applied; call apply().",
    },
  ]);
});

test("synchronous reads transfer large data without clipping", async () => {
  const content = "x".repeat(2 * 1024 * 1024);
  const output: unknown[] = [];
  await executeApplySource(
    "const doc = read({}); result({length: doc.content.length, last: doc.content.at(-1)});",
    {
      async execute() {
        return { content };
      },
      async result(value) {
        output.push(value);
      },
    },
  );
  expect(output).toEqual([{ length: content.length, last: "x" }]);
});

test("guest editor failures retain actionable Apply error codes", async () => {
  let caught: unknown;
  try {
    await executeApplySource('throw new Error("Expected exactly one match, found 2");', {
      execute: async () => null,
      result: async () => {},
    });
  } catch (error) {
    caught = error;
  }
  expect(serializeApplyError(caught)).toMatchObject({ code: "AMBIGUOUS_MATCH" });
});
test("synchronous bridge timeout aborts host work", async () => {
  let aborted = false;
  await expect(
    executeApplySource(
      "read({});",
      {
        async execute(_operation, _args, signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          aborted = signal.aborted;
          signal.throwIfAborted();
        },
        async result() {},
      },
      undefined,
      { timeoutMs: 1000 },
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(aborted).toBe(true);
});
