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
    if (typeof result !== "undefined") throw new Error("result should be hidden");
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

test("linewise between and positional selectors stage insertion moves", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    `const source=open("source.txt");
const target=open("target.txt");
const block=source.between("// BEGIN", "// END", {lines:true});
move(block, target.end());
copy(source.line(1), target.start());
copy(source.line(1), target.before(target.line(1)));
copy(source.line(1), target.after(target.line(1)));
flush();`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return arguments_ && (arguments_ as { path?: string }).path === "source.txt"
            ? snapshot("source", "keep\n// BEGIN\nbody\n// END\nafter\n")
            : snapshot("target", "last");
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
      kind: "text-move",
      sources: [
        {
          from: 5,
          to: 26,
          text: "// BEGIN\nbody\n// END\n",
          linewise: true,
        },
      ],
      destinations: [{ from: 4, to: 4, text: "", linewise: true }],
    },
    {
      kind: "text-copy",
      destinations: [{ from: 0, to: 0, text: "", linewise: true }],
    },
    {
      kind: "text-copy",
      destinations: [{ from: 0, to: 0, text: "", linewise: true }],
    },
    {
      kind: "text-copy",
      destinations: [{ from: 4, to: 4, text: "", linewise: true }],
    },
  ]);
});

test("linewise content boundaries exclude the following blank separator", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    `const file=open("cases.test.ts");
file.remove(file.between('test("named", () => {', "});", {lines:true}));
file.flush();`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return snapshot(
            "cases",
            'before\ntest("named", () => {\n  expect(true);\n});\n\nafter\n',
          );
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
      selection: {
        text: 'test("named", () => {\n  expect(true);\n});\n',
        linewise: true,
      },
      text: "",
    },
  ]);
});
test("between composes string and SelectionSet boundaries", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    'const file=open("note.txt"); file.remove(file.between(file.line(2), "end", {inside:true})); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "keep\nstart\nbody\nend\nkeep\n");
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
    { kind: "replace", selection: { text: "body\n" }, text: "" },
  ]);
});

test("selection combinators preserve guarded sets", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    `const file=open("note.txt");
const words=file.find("hit");
file.replace(file.slice(words, -1), "LAST");
file.insertBefore(file.union(file.slice(words, 0, 1), file.find("other")), ">");
file.remove(file.within(words, file.line(2)));
file.replace(file.linesOf(file.find("tail")), "TAIL");
flush();`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "hit other\nhit\nhit\ntail here\n");
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
    { selection: { from: 14, to: 17, text: "hit" }, text: "LAST" },
    { selection: { from: 0, to: 0 }, text: ">" },
    { selection: { from: 4, to: 4 }, text: ">" },
    { selection: { from: 10, to: 13, text: "hit" }, text: "" },
    { selection: { from: 18, to: 28, text: "tail here\n", linewise: true }, text: "TAIL" },
  ]);
});

test("union rejects overlapping selections before staging mutations", async () => {
  let caught: unknown;
  try {
    await executeApplySource(
      'const file=open("note.txt"); file.union(file.line(1), file.find("hit"));',
      {
        async execute(operation) {
          if (operation === "editorOpen") return snapshot("note", "hit here\n");
          return null;
        },
        async result() {},
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(serializeApplyError(caught)).toMatchObject({ code: "INVALID_SELECTION" });
});

test("selection composition rejects foreign and stale sets", async () => {
  let opened = 0;
  let foreign: unknown;
  try {
    await executeApplySource(
      'const a=open("a.txt"); const b=open("b.txt"); a.union(b.find("b"));',
      {
        async execute(operation) {
          if (operation === "editorOpen")
            return opened++ === 0 ? snapshot("a", "a") : snapshot("b", "b");
          return null;
        },
        async result() {},
      },
    );
  } catch (error) {
    foreign = error;
  }
  expect(serializeApplyError(foreign)).toMatchObject({ code: "CROSS_FILE_SELECTION" });

  let stale: unknown;
  try {
    await executeApplySource(
      'const file=open("a.txt"); const old=file.find("a"); file.replace(old,"A"); flush(); file.slice(old,0,1);',
      {
        async execute(operation) {
          if (operation === "editorOpen") return snapshot("a", "a");
          if (operation === "editorApply")
            return {
              operation: "apply",
              ok: true,
              effect: "applied",
              files: [],
              completed: [],
              errors: [],
              snapshots: [snapshot("a", "A")],
            };
          return null;
        },
        async result() {},
      },
    );
  } catch (error) {
    stale = error;
  }
  expect(serializeApplyError(stale)).toMatchObject({ code: "STALE_SELECTION" });
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

test("global text mutations mirror document methods", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    `const file=open("note.txt");
remove(file.find("one"));
replace(file.find("two"), "TWO");
insertBefore(file.find("three"), "[");
insertAfter(file.find("three"), "]");
file.remove(file.find("four"));
flush();`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "one two three four");
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
    { kind: "replace", selection: { text: "one" }, text: "" },
    { kind: "replace", selection: { text: "two" }, text: "TWO" },
    { kind: "replace", selection: { from: 8, to: 8 }, text: "[" },
    { kind: "replace", selection: { from: 13, to: 13 }, text: "]" },
    { kind: "replace", selection: { text: "four" }, text: "" },
  ]);
});

test("file flush commits only independent operations for that document", async () => {
  const requests: { operations: unknown[] }[] = [];
  let opened = 0;
  await executeApplySource(
    `const first=open("first.txt");
const second=open("second.txt");
const third=open("third.txt");
first.remove(first.find("drop"));
second.replace(second.find("old"), "new");
move(second.find("move"), third.end());
first.flush();
flush();`,
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") {
          opened += 1;
          if (opened === 1) return snapshot("first", "drop");
          if (opened === 2) return snapshot("second", "old move");
          return snapshot("third", "target");
        }
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
  expect(requests.map(({ operations }) => operations)).toMatchObject([
    [{ kind: "replace", selection: { document: "first", text: "drop" } }],
    [{ kind: "replace", selection: { document: "second", text: "old" } }, { kind: "text-move" }],
  ]);
});

test("file flush leaves a transfer participant on the shared pending snapshot", async () => {
  const requests: { operations: unknown[] }[] = [];
  let opened = 0;
  await executeApplySource(
    'const source=open("source.txt"); const target=open("target.txt"); source.remove(source.find("drop")); move(source.find("move"), target.end()); source.flush(); flush();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen")
          return opened++ === 0 ? snapshot("source", "drop move") : snapshot("target", "target");
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
  expect(requests).toHaveLength(1);
  expect(requests[0]?.operations).toHaveLength(2);
});

test("file delete stages pending edits before deleting the opened file", async () => {
  const requests: { operations: unknown[] }[] = [];
  await executeApplySource(
    'const file=open("note.txt"); replace(file.find("before"), "after"); file.delete();',
    {
      async execute(operation, arguments_) {
        if (operation === "editorOpen") return snapshot("note", "before\n");
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
    { kind: "replace", selection: { document: "note" }, text: "after" },
    { kind: "delete", path: "/tmp/note.txt" },
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
