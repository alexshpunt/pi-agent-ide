import { expect, test } from "vitest";
import {
  FileMutationResult,
  type MutationFormatting,
} from "#src/core/mutation-result/file-mutation-result.js";
import {
  groupReplacements,
  renderGroupedReplacements,
} from "#src/core/mutation-result/grouped-replacements.js";

function result(
  path: string,
  pairs: readonly (readonly [string, string])[],
  formatting: MutationFormatting["status"] = "not-reported",
): FileMutationResult {
  return new FileMutationResult({
    ok: true,
    path,
    formatting: { status: formatting },
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

test("three receipts for one file count one file and retain every observed formatter state", () => {
  const grouped = groupReplacements([
    result("a", [["old", "new"]], "deferred"),
    result("a", [["old", "new"]], "deferred"),
    result("a", [["old", "new"]], "unavailable"),
  ]);
  expect(grouped).toMatchObject({ changes: 3, files: [{ path: "a", groups: [3] }] });
  expect(grouped?.files).toHaveLength(1);
  if (!grouped) throw new Error("Missing grouped receipt");
  const rendered = renderGroupedReplacements(grouped);
  expect(rendered).toContain("Applied 3 replacements in 1 file.");
  expect(rendered.match(/^a:/gm)).toHaveLength(1);
  expect(rendered).toContain("a: G1 x 3; formatting: deferred, unavailable");
});

test("repeated files aggregate different pairs without hiding formatter failures", () => {
  const grouped = groupReplacements([
    result("a", [["old", "new"]], "changed"),
    result("b", [["old", "new"]], "unchanged"),
    result("a", [["other", "updated"]], "failed"),
    result("a", [["other", "updated"]], "deferred"),
  ]);
  expect(grouped).toMatchObject({
    changes: 4,
    files: [
      { path: "a", groups: [1, 2] },
      { path: "b", groups: [1] },
    ],
  });
  expect(grouped?.files).toHaveLength(2);
  if (!grouped) throw new Error("Missing grouped receipt");
  const rendered = renderGroupedReplacements(grouped);
  expect(rendered).toContain("a: G1 x 1, G2 x 2; formatting: changed, failed, deferred");
  expect(rendered).toContain("b: G1 x 1; formatting: unchanged");
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
