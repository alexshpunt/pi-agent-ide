import { expect, test } from "vitest";

import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";

test("rejects overlapping typed selection ranges", () => {
  expect(
    () =>
      new TextSelectionAnchor("SEARCH#typed", "/workspace/source.txt", [
        {
          start: { lineNumber: 1, column: 0 },
          end: { lineNumber: 1, column: 8 },
        },
        {
          start: { lineNumber: 1, column: 7 },
          end: { lineNumber: 1, column: 12 },
        },
      ]),
  ).toThrow("must be ordered and must not overlap");
});

test("accepts adjacent whole-line ranges without merging them", () => {
  const anchor = new TextSelectionAnchor("SEARCH#typed", "/workspace/source.txt", [
    {
      start: { lineNumber: 1, column: 0 },
      end: { lineNumber: 2, column: 0 },
      linewise: true,
    },
    {
      start: { lineNumber: 2, column: 0 },
      end: { lineNumber: 3, column: 0 },
      linewise: true,
    },
  ]);

  expect(anchor.ranges).toHaveLength(2);
});
