import { expect, test } from "vitest";
import { createTextDocument } from "pi-agent-text";
import type { TextEditCompletion } from "#src/api/edit-completion.js";
import {
  committedMutationTargets,
  type OwnedMutationChanges,
} from "#src/core/mutation-result-targets.js";
import { ResultTargetStore } from "pi-agent-resource";
import {
  attachCommittedMutationTarget,
  setMutationSnapshotReader,
} from "#src/core/mutation-result-targets.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { FileMutationResult } from "#src/api/mutation-result.js";
import { wholeFileResultSource } from "#src/core/result-input.js";

test("a whole-file result includes the saved final line separator", async () => {
  const store = new ResultTargetStore();
  const core = createTextEditorCore();
  const after = "saved café\r\n";
  setMutationSnapshotReader(core, async (source) => ({
    source,
    expectedContent: after,
    readCurrent: async () => after,
    ranges: [{ start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 } }],
  }));
  const result = await attachCommittedMutationTarget(
    {
      content: [],
      details: {
        results: [
          new FileMutationResult({
            ok: true,
            path: "/workspace/note.txt",
            rawChanges: [
              {
                editIndex: 0,
                fromA: 0,
                toA: 3,
                fromB: 0,
                toB: after.length,
                removedText: "old",
                insertedText: after,
              },
            ],
          }),
        ],
      },
    },
    [completion("old", after)],
    core,
    store,
    "write",
    "/workspace",
    undefined,
    true,
  );
  const target = result.details.metadata?.resultTarget;
  expect(typeof target).toBe("string");
  if (typeof target !== "string") throw Error("No confirmed write target");
  expect(wholeFileResultSource(store.resolve(target, "/workspace"))).toBe("/workspace/note.txt");
});

test("a refused output reread never hides a saved edit or grants source authority", async () => {
  const store = new ResultTargetStore();
  const core = createTextEditorCore();
  setMutationSnapshotReader(core, async () => {
    throw Error("Owned saved content is blocked");
  });
  const result = await attachCommittedMutationTarget(
    {
      content: [],
      details: {
        effect: "applied",
        results: [
          new FileMutationResult({
            ok: true,
            path: "/workspace/note.txt",
            rawChanges: [
              {
                editIndex: 0,
                fromA: 0,
                toA: 3,
                fromB: 0,
                toB: 3,
                removedText: "old",
                insertedText: "new",
              },
            ],
          }),
        ],
      },
    },
    [completion("old", "new")],
    core,
    store,
    "replace",
    "/workspace",
  );
  expect(result.details.effect).toBe("applied");
  expect(result.details.metadata?.resultTarget).toBeUndefined();
  expect(result.details.metadata?.targetUnavailable).toContain("blocked");
});
function completion(before: string, after: string, resolvedBy = "filesystem"): TextEditCompletion {
  return {
    source: "/workspace/note.txt",
    resourceSource: "/workspace/note.txt",
    resolvedBy,
    cwd: "/workspace",
    existed: true,
    before: createTextDocument("/workspace/note.txt", before),
    after: createTextDocument("/workspace/note.txt", after),
    intent: "edit",
  };
}
function mutation(callId: string, from: number, to: number, insert: string): OwnedMutationChanges {
  return {
    callId,
    edits: new Map([
      ["/workspace/note.txt", { action: "edited", changes: [{ from, to, insert }] }],
    ]),
  };
}

test("maps ownership past earlier changes with CRLF and UTF16 positions", () => {
  const targets = committedMutationTargets(
    [mutation("first", 2, 3, "new\r\nline"), mutation("second", 8, 9, "NEW")],
    [completion("x A\r\n😀 B", "x new\r\nline\r\n😀 NEW")],
  );
  expect(targets.get("second")).toMatchObject([
    {
      source: "/workspace/note.txt",
      expectedContent: "x new\r\nline\r\n😀 NEW",
      ranges: [{ start: { lineNumber: 3, column: 3 }, end: { lineNumber: 3, column: 6 } }],
    },
  ]);
});

test("retains separate ownership for insertions at the same position", () => {
  const targets = committedMutationTargets(
    [mutation("first", 0, 0, "A"), mutation("second", 0, 0, "B")],
    [completion("tail", "ABtail")],
  );
  expect(targets.get("first")?.[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 1 } },
  ]);
  expect(targets.get("second")?.[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 1 }, end: { lineNumber: 1, column: 2 } },
  ]);
});
test.each([
  { before: "old", after: "", from: 0, to: 3, insert: "", lineNumber: 1, column: 0 },
  { before: "x\r\nold", after: "x\r\n", from: 3, to: 6, insert: "", lineNumber: 2, column: 0 },
])("keeps the resulting empty position at EOF in $after", (item) => {
  const targets = committedMutationTargets(
    [mutation("empty", item.from, item.to, item.insert)],
    [completion(item.before, item.after)],
  );
  const position = { lineNumber: item.lineNumber, column: item.column };
  expect(targets.get("empty")?.[0]?.ranges).toEqual([{ start: position, end: position }]);
});

test("move outputs omit removals but include their shifts in destination coordinates", () => {
  const targets = committedMutationTargets(
    [
      {
        callId: "move",
        edits: new Map([
          [
            "/workspace/note.txt",
            {
              action: "edited",
              resultChanges: [1],
              changes: [
                { from: 0, to: 3, insert: "" },
                { from: 8, to: 11, insert: "ONE" },
              ],
            },
          ],
        ]),
      },
    ],
    [completion("ONE gap TWO", " gap ONE")],
  );
  expect(targets.get("move")?.[0]?.ranges).toEqual([
    { start: { lineNumber: 1, column: 5 }, end: { lineNumber: 1, column: 8 } },
  ]);
});

test("does not guess coordinates after formatting or unsupported resource writes", () => {
  const mutations = [mutation("edit", 0, 3, "new")];
  expect(() => committedMutationTargets(mutations, [completion("old", "formatted")])).toThrow(
    "actual written snapshot",
  );
  expect(committedMutationTargets(mutations, [completion("old", "new", "custom")]).size).toBe(0);
});
