import { expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
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
    if (typeof open !== "function" || typeof flush !== "function") throw new Error("editor missing");
    if (typeof apply !== "undefined") throw new Error("legacy apply checkpoint remains");
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

test("find returns zero, one, or many immutable ranges without findAll", async () => {
  for (const [content, count] of [
    ["none", 0],
    ["same", 1],
    ["same same", 2],
  ] as const) {
    const requests: { operations: unknown[] }[] = [];
    await executeApplySource(
      `const file=open("note.txt"); if(typeof file.findAll !== "undefined") throw new Error("findAll remains"); const found=file.find("same"); if(!Object.isFrozen(found)||found.length!==${count}) throw new Error("bad set"); file.replace(found,"new"); flush();`,
      {
        async execute(operation, arguments_) {
          if (operation === "editorOpen") return snapshot("note", content);
          if (operation === "editorResolve")
            return { selections: [], warning: { code: "missing" } };
          if (operation === "editorApply") {
            requests.push(arguments_ as { operations: unknown[] });
            return {
              operation: "apply",
              ok: true,
              effect: "applied",
              files: [],
              completed: [],
              errors: [],
            };
          }
          return null;
        },
        async result() {},
      },
    );
    expect(requiredValue(requests[0]).operations).toHaveLength(count === 0 ? 1 : count);
    if (count === 0)
      expect(requiredValue(requests[0]).operations[0]).toMatchObject({
        kind: "warning",
        query: "same",
      });
  }
});

test("between returns all sequential non-overlapping pairs", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    'const file=open("note.txt"); file.remove(file.between("<", ">", {inside:true})); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "<a> x <b>");
        if (operation === "editorApply") {
          requests.push(arguments_ as { operations: unknown[] });
          return {
            operation: "apply",
            ok: true,
            effect: "applied",
            files: [],
            completed: [],
            errors: [],
          };
        }
        return null;
      },
      async result() {},
    },
  );
  expect(requiredValue(requests[0]).operations).toMatchObject([
    { kind: "replace", selection: { from: 1, to: 2, text: "a" }, text: "" },
    { kind: "replace", selection: { from: 7, to: 8, text: "b" }, text: "" },
  ]);
});

test("direct string targets resolve through the host and apply every returned range", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource('const file=open("note.txt"); file.replace("same", "new"); flush();', {
    async execute(operation, arguments_) {
      if (operation === "editorOpen") return snapshot("note", "same same");
      if (operation === "editorResolve")
        return {
          selections: [
            { document: "note", from: 0, to: 4, text: "same" },
            { document: "note", from: 5, to: 9, text: "same" },
          ],
        };
      if (operation === "editorApply") {
        requests.push(arguments_ as { operations: unknown[] });
        return {
          operation: "apply",
          ok: true,
          effect: "applied",
          files: [],
          completed: [],
          errors: [],
        };
      }
      return null;
    },
    async result() {},
  });
  expect(requiredValue(requests[0]).operations).toHaveLength(2);
});
test("direct linewise string targets retain resolver metadata", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    'const file=open("note.txt"); file.replace("before", "after"); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "before\nnext\n");
        if (operation === "editorResolve")
          return {
            selections: [{ document: "note", from: 0, to: 7, text: "before\n", linewise: true }],
          };
        if (operation === "editorApply") {
          requests.push(arguments_ as { operations: unknown[] });
          return {
            operation: "apply",
            ok: true,
            effect: "applied",
            files: [],
            completed: [],
            errors: [],
          };
        }
        return null;
      },
      async result() {},
    },
  );
  expect(requiredValue(requests[0]).operations).toMatchObject([
    {
      kind: "replace",
      selection: { from: 0, to: 7, text: "before\n", linewise: true },
      text: "after",
    },
  ]);
});

test("normal completion auto-commits pending operations once", async () => {
  const calls: string[] = [];
  await executeApplySource('const file=open("note.txt"); file.replace("before", "after");', {
    async execute(operation) {
      calls.push(operation);
      if (operation === "editorOpen") return snapshot("note", "before");
      if (operation === "editorResolve")
        return { selections: [{ document: "note", from: 0, to: 6, text: "before" }] };
      if (operation === "editorApply")
        return {
          operation: "apply",
          ok: true,
          effect: "applied",
          files: [],
          completed: [],
          errors: [],
          snapshots: [snapshot("note", "after")],
        };
      return null;
    },
    async result() {},
  });
  expect(calls).toEqual(["editorOpen", "editorResolve", "editorApply"]);
});
test("a normal early return still auto-commits pending operations", async () => {
  const calls: string[] = [];
  await executeApplySource('createFile("note.txt", "content"); return;', {
    async execute(operation) {
      calls.push(operation);
      if (operation === "editorApply")
        return {
          operation: "apply",
          ok: true,
          effect: "applied",
          files: [],
          completed: [],
          errors: [],
          snapshots: [],
        };
      return null;
    },
    async result() {},
  });
  expect(calls).toEqual(["editorApply"]);
});

test("an exception does not auto-commit pending operations", async () => {
  const calls: string[] = [];
  await expect(
    executeApplySource('createFile("note.txt", "content"); throw new Error("stop");', {
      async execute(operation) {
        calls.push(operation);
        return null;
      },
      async result() {},
    }),
  ).rejects.toThrow("stop");
  expect(calls).toEqual([]);
});

test("the same handle continues after a checkpoint while old selections become stale", async () => {
  const requests: { operations: unknown[] }[] = [];
  let applyCount = 0;
  await executeApplySource(
    'const file=open("note.txt"); const old=file.find("one"); file.replace(old,"ONE"); flush(); let stale=false; try { file.replace(old,"bad"); } catch(error) { stale=error.code==="STALE_SELECTION"; } if(!stale) throw new Error("old selection remained current"); file.replace("two","TWO");',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "one two");
        if (operation === "editorResolve")
          return { selections: [{ document: "note", from: 4, to: 7, text: "two" }] };
        if (operation === "editorApply") {
          requests.push(arguments_ as { operations: unknown[] });
          applyCount += 1;
          return {
            operation: "apply",
            ok: true,
            effect: "applied",
            files: [],
            completed: [],
            errors: [],
            snapshots: [snapshot("note", applyCount === 1 ? "ONE two" : "ONE TWO")],
          };
        }
        return null;
      },
      async result() {},
    },
  );
  expect(requests.map(({ operations }) => operations.length)).toEqual([1, 1]);
});

test("normal completion with no pending mutations does not call the transaction host", async () => {
  const calls: string[] = [];
  await executeApplySource(
    'const file=open("note.txt"); if(file.content!=="same") throw new Error("bad");',
    {
      async execute(operation) {
        calls.push(operation);
        return snapshot("note", "same");
      },
      async result() {},
    },
  );
  expect(calls).toEqual(["editorOpen"]);
});

test("copy and move stage one coherent transfer operation", async () => {
  const requests: { operations: unknown[] }[] = [];
  let opened = 0;
  await executeApplySource(
    'const source=open("source.txt"); const target=open("target.txt"); copy(source.find("a"), target.find("x")); move(source.find("b"), target.find("y")); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return opened++ === 0 ? snapshot("source", "a b") : snapshot("target", "x y");
        if (operation === "editorApply") {
          requests.push(arguments_ as { operations: unknown[] });
          return {
            operation: "apply",
            ok: true,
            effect: "applied",
            files: [],
            completed: [],
            errors: [],
          };
        }
        return null;
      },
      async result() {},
    },
  );
  expect(requiredValue(requests[0]).operations).toMatchObject([
    { kind: "text-copy", text: "a", sources: [{ text: "a" }], destinations: [{ text: "x" }] },
    { kind: "text-move", text: "b", sources: [{ text: "b" }], destinations: [{ text: "y" }] },
  ]);
});

test("an empty transfer set warns without staging source deletion", async () => {
  const requests: { operations: unknown[] }[] = [];
  let opened = 0;
  await executeApplySource(
    'const source=open("source.txt"); const target=open("target.txt"); move(source.find("a"), target.find("missing")); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return opened++ === 0 ? snapshot("source", "a") : snapshot("target", "x");
        if (operation === "editorResolve")
          return { selections: [], warning: { code: "EMPTY_SELECTION", message: "missing" } };
        if (operation === "editorApply") {
          requests.push(arguments_ as { operations: unknown[] });
          return {
            operation: "apply",
            ok: false,
            effect: "not-applied",
            files: [],
            completed: [],
            errors: [],
          };
        }
        return null;
      },
      async result() {},
    },
  );
  expect(requiredValue(requests[0]).operations).toMatchObject([{ kind: "warning" }]);
});

test("staged operations without flush auto-commit through the mutation host", async () => {
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
  expect(calls).toEqual(["editorApply"]);
  expect(output).toEqual([]);
});

test("a script can commit several fresh transactions", async () => {
  const calls: string[] = [];
  await executeApplySource(
    'createFile("one.txt", "1"); flush(); createFile("two.txt", "2"); flush();',
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
    'createFile("one.txt", "1"); try { flush(); } catch (error) { result({code: error.code, details: error.details}); }',
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
  expect(output).toEqual([{ code: "TRANSACTION_FAILED", details: { effect: "rolled-back" } }]);
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
