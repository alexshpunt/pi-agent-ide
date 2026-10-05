import path from "node:path";
import { createTextDocument } from "pi-agent-text";
import type { ResolvedResultTargets } from "pi-agent-resource";
import { expect, test } from "vitest";
import { selectTextRegions } from "./text-selection.js";

function input(content: string, pieces = [content], source = "fixture.txt"): ResolvedResultTargets {
  const document = createTextDocument(source, content);
  const starts = [0];
  for (const line of document.lines)
    starts.push((starts.at(-1) ?? 0) + line.content.length + line.lineEnding.length);
  const point = (offset: number) => {
    let index = starts.length - 1;
    while (index > 0 && (starts[index] ?? 0) > offset) index--;
    if (index === document.lines.length && !document.lines.at(-1)?.lineEnding && index > 0) index--;
    return { lineNumber: index + 1, column: offset - (starts[index] ?? 0) };
  };
  return {
    complete: true,
    targets: [
      {
        source: path.resolve(source),
        expectedContent: content,
        ranges: pieces.map((piece) => {
          const from = content.indexOf(piece);
          if (from < 0) throw Error("Missing fixture piece");
          return { start: point(from), end: point(from + piece.length) };
        }),
      },
    ],
  };
}

const texts = (result: ReturnType<typeof selectTextRegions>) =>
  result.regions.map((region) => region.text);

test("pairs literal markers per sparse region without balancing or crossing a gap", () => {
  const source = "outside < A > gap < B > outside";
  for (const [extent, expected] of [
    ["inside", [" A ", " B "]],
    ["around", ["< A >", "< B >"]],
  ] as const) {
    const result = selectTextRegions(input(source, ["< A >", "< B >"]), {
      kind: "between",
      start: "<",
      end: ">",
      extent,
    });
    expect(texts(result)).toEqual(expected);
    expect(result.regions.every((region) => region.origins[0]?.expanded === false)).toBe(true);
  }
  expect(() =>
    selectTextRegions(input(source, ["< A", "B >"]), {
      kind: "between",
      start: "<",
      end: ">",
      extent: "inside",
    }),
  ).toThrow(/closing marker/iu);
  expect(
    texts(
      selectTextRegions(input("x|a| y |b|"), {
        kind: "between",
        start: "|",
        end: "|",
        extent: "inside",
      }),
    ),
  ).toEqual(["a", "b"]);
  expect(
    texts(
      selectTextRegions(input("<a<b>"), {
        kind: "between",
        start: "<",
        end: ">",
        extent: "inside",
      }),
    ),
  ).toEqual(["a<b"]);
});

test("distinguishes absent markers from an incomplete pair and rejects empty delimiters", () => {
  expect(
    selectTextRegions(input("safe"), { kind: "between", start: "<", end: ">", extent: "inside" })
      .missingInputs,
  ).toBe(1);
  expect(() =>
    selectTextRegions(input("<safe"), { kind: "between", start: "<", end: ">", extent: "inside" }),
  ).toThrow(/closing marker/iu);
  expect(() =>
    selectTextRegions(input("safe"), { kind: "between", start: "", end: ">", extent: "inside" }),
  ).toThrow(/non-empty/iu);
  expect(() => selectTextRegions(input("safe"), { kind: "split", delimiter: "" })).toThrow(
    /non-empty/iu,
  );
});

test("slices source text, not the items array, using strict UTF-16 offsets", () => {
  expect(
    texts(
      selectTextRegions(input("x😀one y😀two", ["😀one", "😀two"]), { kind: "sliceText", from: 2 }),
    ),
  ).toEqual(["one", "two"]);
  const zero = selectTextRegions(input("😀one"), { kind: "sliceText", from: 2, to: 2 });
  expect(texts(zero)).toEqual([""]);
  expect(zero.regions[0]?.range.start).toEqual(zero.regions[0]?.range.end);
  for (const operation of [
    { kind: "sliceText", from: 1 },
    { kind: "sliceText", from: 0, to: 1 },
    { kind: "sliceText", from: 6 },
    { kind: "sliceText", from: -1 },
    { kind: "sliceText", from: 3, to: 2 },
  ] as const)
    expect(() => selectTextRegions(input("😀one"), operation)).toThrow(/boundary|bounds/iu);
  expect(() => selectTextRegions(input("A\r\nB"), { kind: "sliceText", from: 2 })).toThrow(
    /boundary/iu,
  );
});

test("trims selected Unicode whitespace and retains empty split segments as points", () => {
  for (const [side, expected] of [
    ["start", "A \t"],
    ["end", "\u2003 A"],
    ["both", "A"],
  ] as const)
    expect(
      texts(
        selectTextRegions(input("outside\u2003 A \toutside", ["\u2003 A \t"]), {
          kind: "trim",
          side,
        }),
      ),
    ).toEqual([expected]);
  const empty = selectTextRegions(input(" \r\n\t"), { kind: "trim", side: "both" });
  expect(texts(empty)).toEqual([""]);
  expect(empty.regions[0]?.range.start).toEqual({ lineNumber: 2, column: 1 });
  expect(texts(selectTextRegions(input("a,,b,"), { kind: "split", delimiter: "," }))).toEqual([
    "a",
    "",
    "b",
    "",
  ]);
});

test("reports explicit full-line expansion and preserves CRLF, bare CR and EOF", () => {
  const source = "prefix <A> suffix\r\nB\r\nEOF";
  const expanded = selectTextRegions(input(source, ["<A>"]), {
    kind: "between",
    start: "<",
    end: ">",
    extent: "lines",
  });
  expect(texts(expanded)).toEqual(["prefix <A> suffix\r\n"]);
  expect(expanded.regions[0]?.origins[0]?.expanded).toBe(true);
  expect(texts(selectTextRegions(input(source, ["B\r\n"]), { kind: "linesOf" }))).toEqual([
    "B\r\n",
  ]);
  expect(texts(selectTextRegions(input(source, ["EOF"]), { kind: "linesOf" }))).toEqual(["EOF"]);
  expect(texts(selectTextRegions(input("A\rB\r", ["B"]), { kind: "linesOf" }))).toEqual(["B\r"]);
  const empty = selectTextRegions(input(""), { kind: "linesOf" });
  expect(texts(empty)).toEqual([""]);
});

test("requires absolute ranges and lines to fit one retained source region", () => {
  const source = "😀A\r\nB\r\nEOF";
  expect(
    texts(
      selectTextRegions(input(source), {
        kind: "range",
        startLine: 1,
        startColumn: 2,
        endLine: 2,
        endColumn: 1,
      }),
    ),
  ).toEqual(["A\r\nB"]);
  expect(texts(selectTextRegions(input(source), { kind: "lines", first: 2, last: 2 }))).toEqual([
    "B\r\n",
  ]);
  expect(() =>
    selectTextRegions(input(source, ["A", "EOF"]), {
      kind: "range",
      startLine: 1,
      startColumn: 2,
      endLine: 3,
      endColumn: 3,
    }),
  ).toThrow(/scope/iu);
  expect(() =>
    selectTextRegions(input(source, ["B"]), { kind: "lines", first: 2, last: 2 }),
  ).toThrow(/scope/iu);
  expect(() =>
    selectTextRegions(input(source), {
      kind: "range",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 3,
    }),
  ).toThrow(/boundary/iu);
  expect(() => selectTextRegions(input(source), { kind: "lines", first: 2, last: 4 })).toThrow(
    /bounds/iu,
  );
  const multi = {
    complete: true,
    targets: [...input("A").targets, ...input("B", ["B"], "other.txt").targets],
  };
  expect(() => selectTextRegions(multi, { kind: "lines", first: 1, last: 1 })).toThrow(
    /one source/iu,
  );
});

test("returns per-region positions, including an EOF point without widening", () => {
  const source = "A gap B";
  const before = selectTextRegions(input(source, ["A", "B"]), { kind: "position", edge: "before" });
  const after = selectTextRegions(input(source, ["A", "B"]), { kind: "position", edge: "after" });
  expect(before.regions.map((r) => r.range.start.column)).toEqual([0, 6]);
  expect(after.regions.map((r) => r.range.start.column)).toEqual([1, 7]);
  expect(
    [...before.regions, ...after.regions].every(
      (r) => r.range.start.column === r.range.end.column && !r.origins[0]?.expanded,
    ),
  ).toBe(true);
});

test("selects columns on touched lines and refuses short lines or partial scopes", () => {
  expect(
    texts(selectTextRegions(input("😀one\r\nXXtwo\r\n"), { kind: "columns", from: 2, to: 5 })),
  ).toEqual(["one", "two"]);
  expect(() => selectTextRegions(input("long\r\nx"), { kind: "columns", from: 0, to: 2 })).toThrow(
    /bounds/iu,
  );
  expect(() =>
    selectTextRegions(input("prefix body", ["body"]), { kind: "columns", from: 0, to: 2 }),
  ).toThrow(/scope/iu);
  expect(() => selectTextRegions(input("😀one"), { kind: "columns", from: 1, to: 3 })).toThrow(
    /boundary/iu,
  );
});

test("keeps all inputs and origins, deduplicating equal geometry but not sparse gaps", () => {
  const source = "one two";
  const result = selectTextRegions(input(source, ["one", "one", "two"]), {
    kind: "trim",
    side: "both",
  });
  expect(texts(result)).toEqual(["one", "two"]);
  expect(result.regions[0]?.origins).toHaveLength(2);
  expect(
    texts(
      selectTextRegions(
        {
          complete: false,
          targets: [...input(" A ").targets, ...input(" B ", [" B "], "other.txt").targets],
        },
        { kind: "trim", side: "both" },
      ),
    ),
  ).toEqual(["A", "B"]);
  expect(
    selectTextRegions({ complete: true, targets: [] }, { kind: "position", edge: "before" }),
  ).toEqual({ regions: [], missingInputs: 0 });
  expect(() =>
    selectTextRegions(input(" A "), { kind: "trim", side: "both" }, AbortSignal.abort()),
  ).toThrow(/abort/iu);
});
