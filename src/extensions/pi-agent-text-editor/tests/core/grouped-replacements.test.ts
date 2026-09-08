import { expect, test } from "vitest";
import { FileMutationResult } from "#src/core/mutation-result/file-mutation-result.js";
import { groupReplacements } from "#src/core/mutation-result/grouped-replacements.js";

function result(path: string, pairs: readonly (readonly [string, string])[]): FileMutationResult {
  return new FileMutationResult({
    ok: true,
    path,
    operations: [{ operation: "replace", changes: pairs.length }],
    rawChanges: pairs.map(([removedText, insertedText], editIndex) => ({
      editIndex,
      fromA: 0,
      toA: removedText.length,
      fromB: 0,
      toB: insertedText.length,
      removedText,
      insertedText,
    })),
  });
}

test("groups exact pairs across files without normalizing distinct characters", () => {
  const grouped = groupReplacements([
    result("a", [
      ["old", "new"],
      ["old", "new"],
    ]),
    result("b", [
      ["old", "new"],
      ["old\u200b", "new\u200b"],
    ]),
  ]);
  expect(grouped).toMatchObject({
    changes: 4,
    groups: [
      { removedText: "old", insertedText: "new", count: 3 },
      { removedText: "old\u200b", insertedText: "new\u200b", count: 1 },
    ],
    files: [
      { path: "a", groups: [2] },
      { path: "b", groups: [1, 1] },
    ],
  });
});

test("keeps full output for unique replacements, failed results and missing evidence", () => {
  expect(groupReplacements([result("a", [["a", "b"]])])).toBeUndefined();
  expect(
    groupReplacements([
      result("a", [
        ["a", "b"],
        ["a", "b"],
      ]),
      new FileMutationResult({ ok: false }),
    ]),
  ).toBeUndefined();
  expect(
    groupReplacements([
      new FileMutationResult({
        ok: true,
        path: "a",
        operations: [{ operation: "replace", changes: 2 }],
      }),
    ]),
  ).toBeUndefined();
});
