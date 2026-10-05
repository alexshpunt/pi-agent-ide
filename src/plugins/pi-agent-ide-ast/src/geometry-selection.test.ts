import path from "node:path";
import { expect, test } from "vitest";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { selectGeometryRegions } from "./geometry-selection.js";
import { SourceText } from "./source-text.js";

const empty: ResolvedResultTargets = { targets: [], complete: true };
function input(
  intervals: readonly (readonly [number, number])[],
  content = "0123456789abcdef",
  file = "geometry.txt",
): ResolvedResultTargets {
  const source = new SourceText(content);
  return {
    complete: true,
    targets: [
      {
        source: path.resolve(file),
        expectedContent: content,
        ranges: intervals.map(([from, to]) => source.range(from, to)),
      },
    ],
  };
}
const spans = (result: ReturnType<typeof selectGeometryRegions>) =>
  result.regions.map((region) => [region.range.start.column, region.range.end.column]);

test("keeps whole candidates within one scope but clips intersection without filling gaps", () => {
  const candidates = input([
    [0, 10],
    [3, 7],
    [12, 14],
  ]);
  const scopes = input([
    [3, 5],
    [5, 7],
  ]);
  expect(spans(selectGeometryRegions(candidates, { kind: "within" }, scopes))).toEqual([]);
  const clipped = selectGeometryRegions(candidates, { kind: "intersection" }, scopes);
  expect(spans(clipped)).toEqual([[3, 7]]);
  expect(clipped.regions[0]?.origins).toHaveLength(2);
  expect(clipped.missingInputs).toBe(1);
  const within = selectGeometryRegions(candidates, { kind: "within" }, input([[2, 8]]));
  expect(spans(within)).toEqual([[3, 7]]);
  expect(within.missingInputs).toBe(2);
  expect(within.regions[0]?.origins[0]?.expanded).toBe(false);
});

test("subtracts overlapping masks into separate surviving fragments, never gap text", () => {
  const result = selectGeometryRegions(
    input([[0, 14]]),
    { kind: "difference" },
    input([
      [2, 5],
      [4, 7],
      [10, 12],
    ]),
  );
  expect(spans(result)).toEqual([
    [0, 2],
    [7, 10],
    [12, 14],
  ]);
  expect(result.regions.map((region) => region.text)).toEqual(["01", "789", "cd"]);
  expect(
    result.regions.every((region) => region.origins.length === 1 && !region.origins[0]?.expanded),
  ).toBe(true);
  expect(
    selectGeometryRegions(input([[3, 5]]), { kind: "difference" }, input([[0, 10]])).missingInputs,
  ).toBe(1);
});

test("matches by file, deduplicates equal geometry and preserves separate candidate origins", () => {
  const candidates = {
    complete: true,
    targets: [
      ...input([
        [0, 3],
        [0, 3],
      ]).targets,
      ...input([[0, 3]], "XYZ", "other.txt").targets,
    ],
  };
  const result = selectGeometryRegions(candidates, { kind: "intersection" }, input([[0, 3]]));
  expect(spans(result)).toEqual([[0, 3]]);
  expect(result.regions[0]?.origins).toHaveLength(2);
  expect(result.missingInputs).toBe(1);
  const difference = selectGeometryRegions(candidates, { kind: "difference" }, input([[0, 3]]));
  expect(difference.regions.map((region) => region.text)).toEqual(["XYZ"]);
  const independent = selectGeometryRegions(
    input([
      [0, 6],
      [4, 10],
    ]),
    { kind: "intersection" },
    input([[2, 8]]),
  );
  expect(spans(independent)).toEqual([
    [2, 6],
    [4, 8],
  ]);
});

test("merges only overlaps by default and adjacency explicitly, retaining every origin", () => {
  const candidates = input([
    [0, 3],
    [2, 5],
    [5, 7],
    [10, 12],
  ]);
  const result = selectGeometryRegions(candidates, { kind: "merge" }, empty);
  expect(spans(result)).toEqual([
    [0, 5],
    [5, 7],
    [10, 12],
  ]);
  expect(result.regions[0]?.origins).toHaveLength(2);
  expect(result.regions[0]?.origins.every((origin) => origin.expanded)).toBe(true);
  expect(
    spans(selectGeometryRegions(candidates, { kind: "merge", adjacent: true }, empty)),
  ).toEqual([
    [0, 7],
    [10, 12],
  ]);
});

test("treats points as positions with included starts and excluded ends", () => {
  const points = input([
    [3, 3],
    [7, 7],
    [16, 16],
  ]);
  expect(
    spans(
      selectGeometryRegions(
        points,
        { kind: "within" },
        input([
          [3, 7],
          [16, 16],
        ]),
      ),
    ),
  ).toEqual([
    [3, 3],
    [16, 16],
  ]);
  expect(
    spans(
      selectGeometryRegions(
        points,
        { kind: "difference" },
        input([
          [3, 7],
          [16, 16],
        ]),
      ),
    ),
  ).toEqual([[7, 7]]);
  expect(
    spans(
      selectGeometryRegions(
        input([[0, 10]]),
        { kind: "intersection" },
        input([
          [3, 3],
          [10, 10],
        ]),
      ),
    ),
  ).toEqual([[3, 3]]);
  expect(
    spans(selectGeometryRegions(input([[0, 3]]), { kind: "intersection" }, input([[3, 7]]))),
  ).toEqual([]);
  expect(spans(selectGeometryRegions(input([[0, 10]]), { kind: "difference" }, points))).toEqual([
    [0, 10],
  ]);
  expect(
    spans(selectGeometryRegions(input([[3, 7]]), { kind: "within" }, input([[3, 3]]))),
  ).toEqual([]);
});

test("merge absorbs covered points without extending or bridging text", () => {
  const candidates = input([
    [0, 3],
    [3, 3],
    [3, 3],
    [4, 7],
    [5, 5],
    [0, 0],
    [16, 16],
  ]);
  const result = selectGeometryRegions(candidates, { kind: "merge", adjacent: true }, empty);
  expect(spans(result)).toEqual([
    [0, 3],
    [3, 3],
    [4, 7],
    [16, 16],
  ]);
  expect(result.regions[0]?.origins).toHaveLength(2);
  expect(result.regions[1]?.origins).toHaveLength(2);
  expect(result.regions[2]?.origins).toHaveLength(2);
});

test("empty scopes never widen inputs and invalid snapshots or cancelled work refuse", () => {
  const candidates = input([[0, 3]]);
  expect(spans(selectGeometryRegions(candidates, { kind: "within" }, empty))).toEqual([]);
  expect(spans(selectGeometryRegions(candidates, { kind: "intersection" }, empty))).toEqual([]);
  expect(spans(selectGeometryRegions(candidates, { kind: "difference" }, empty))).toEqual([[0, 3]]);
  expect(selectGeometryRegions(empty, { kind: "merge" }, empty)).toEqual({
    regions: [],
    missingInputs: 0,
  });
  expect(() =>
    selectGeometryRegions(candidates, { kind: "intersection" }, input([[0, 3]], "changed")),
  ).toThrow(/snapshot/iu);
  expect(() =>
    selectGeometryRegions(candidates, { kind: "merge" }, empty, AbortSignal.abort()),
  ).toThrow(/abort/iu);
});

test("preserves emoji and CRLF boundaries in clipped text", () => {
  const content = "😀A\r\nB\r\nEOF";
  const result = selectGeometryRegions(
    input([[0, content.length]], content),
    { kind: "difference" },
    input(
      [
        [2, 3],
        [5, 6],
      ],
      content,
    ),
  );
  expect(result.regions.map((region) => region.text)).toEqual(["😀", "\r\n", "\r\nEOF"]);
  expect(result.regions[1]?.range).toEqual({
    start: { lineNumber: 1, column: 3 },
    end: { lineNumber: 2, column: 0 },
  });
});
