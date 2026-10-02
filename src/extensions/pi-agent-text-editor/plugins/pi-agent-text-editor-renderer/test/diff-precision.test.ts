import { describe, expect, test } from "vitest";
import { createDiffModel } from "#src/diff-model.js";

function modified(before: string, after: string) {
  const model = createDiffModel(before, after);
  expect(model).toMatchObject({ added: 0, modified: 1, removed: 0 });
  expect(model.rows).toHaveLength(1);
  return model.rows[0];
}

describe("precise inline changes", () => {
  test.each([
    ["timeout: 1_000,", "timeout: 5_000,", [{ from: 9, to: 10 }]],
    ["const userId = 1;", "const userID = 1;", [{ from: 11, to: 12 }]],
    [
      "a1 middle b2",
      "a3 middle b4",
      [
        { from: 1, to: 2 },
        { from: 11, to: 12 },
      ],
    ],
    ["\t👩‍💻 café1", "\t👩‍💻 café2", [{ from: 11, to: 12 }]],
  ])("highlights only changed characters in %s", (before, after, ranges) => {
    expect(modified(before, after)).toMatchObject({ addedRanges: ranges, deletedOffsets: [] });
  });

  test.each([
    ["return await run();", "return run();", [7]],
    ["await run();", "run();", [0]],
    ["run(); // old", "run();", [6]],
    ["a!b?c", "abc", [1, 2]],
    ["  run();  ", "    run();", []],
  ])("marks pure deletions without old text in %s", (before, after, offsets) => {
    const model = createDiffModel(before, after);
    if (offsets.length === 0) {
      expect(model.rows).toEqual([]);
    } else {
      expect(modified(before, after)).toMatchObject({
        text: after,
        addedRanges: [],
        deletedOffsets: offsets,
      });
    }
  });

  test("ignores edge whitespace even when the line has another change", () => {
    expect(modified("  value1();  ", "    value2();")).toMatchObject({
      addedRanges: [{ from: 9, to: 10 }],
      deletedOffsets: [],
    });
  });

  test("keeps partial edits paired next to a real insertion and repeated lines", () => {
    const model = createDiffModel(
      "start\ncall(1);\ncall(1);\nend",
      "start\ncall(2);\ntrace();\ncall(1);\nend",
    );
    expect(model).toMatchObject({ added: 1, modified: 1, removed: 0 });
    expect(model.rows.filter((row) => row.changed)).toMatchObject([
      {
        kind: "modified",
        text: "call(2);",
        beforeLine: 2,
        afterLine: 2,
        addedRanges: [{ from: 5, to: 6 }],
      },
      { kind: "added", text: "trace();", afterLine: 3 },
    ]);
  });

  test("reports exhausted alignment instead of an empty successful comparison", () => {
    const before = Array.from({ length: 11_000 }, (_, index) => `old${index}();`).join("\n");
    const after = Array.from({ length: 11_000 }, (_, index) => `new${index}();`).join("\n");
    const model = createDiffModel(before, after);
    expect(model.omittedChanges?.unavailable).toBe(true);
  });
});
