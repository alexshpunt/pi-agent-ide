import { expect, test } from "vitest";

import { TextSelectionAnchor } from "#src/api/text-selection-anchor.js";

test("copies and validates exact endpoint extents independently of linewise selections", () => {
  const ranges = [
    { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 2, column: 0 }, linewise: true },
  ];
  const endpoint = { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 1, column: 4 } };
  const endpoints = [endpoint];
  const anchor = new TextSelectionAnchor("text", "fixture", ranges, endpoints);
  expect(anchor.endpointRanges).toEqual(endpoints);
  endpoint.end.column = 9;
  expect(anchor.endpointRanges?.[0]?.end.column).toBe(4);
  expect(TextSelectionAnchor.is(anchor)).toBe(true);
  Object.defineProperty(anchor, "endpointRanges", { value: [] });
  expect(TextSelectionAnchor.is(anchor)).toBe(false);
  expect(() => new TextSelectionAnchor("text", "fixture", ranges, [])).toThrow(
    "must contain at least one range",
  );
  expect(
    () =>
      new TextSelectionAnchor("text", "fixture", ranges, [
        { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 3, column: 0 } },
      ]),
  ).toThrow("within their corresponding selection ranges");
});

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
