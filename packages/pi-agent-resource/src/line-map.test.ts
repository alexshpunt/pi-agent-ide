import { describe, expect, test } from "vitest";
import { createLineMap, moveRange, rebaseRange, relocateRange } from "./line-map.ts";
import type { ResultRange } from "./result-targets.ts";

const before = "one\ntwo\nthree\nfour\nfive\n";
const span = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): ResultRange => ({
  start: { lineNumber: startLine, column: startColumn },
  end: { lineNumber: endLine, column: endColumn },
});

function rebased(after: string, range: ResultRange): ResultRange | undefined {
  const map = createLineMap(before, after);
  return map === undefined ? undefined : rebaseRange(range, map);
}

function relocated(after: string, range: ResultRange): ResultRange | undefined {
  const map = createLineMap(before, after);
  return map === undefined ? undefined : relocateRange(range, map, after.split("\n"));
}

describe("line maps", () => {
  const selected = span(3, 1, 3, 4);

  test("moves a range after lines were added or removed above it", () => {
    expect(rebased(`zero\n${before}`, selected)).toEqual(span(4, 1, 4, 4));
    expect(rebased(before.replace("one\n", ""), selected)).toEqual(span(2, 1, 2, 4));
    expect(rebased(before.replace("one\ntwo\n", "A\nB\nC\nD\n"), selected)).toEqual(
      span(5, 1, 5, 4),
    );
  });

  test("keeps a range when only lines below it changed", () => {
    expect(rebased(before.replace("four", "FOUR"), selected)).toEqual(selected);
    expect(rebased(`${before}six\n`, selected)).toEqual(selected);
  });

  test("keeps a range when edits above and below it happen together", () => {
    expect(rebased(`zero\n${before.replace("five", "5\n5")}`, selected)).toEqual(span(4, 1, 4, 4));
  });

  test("drops a range whose own line changed", () => {
    expect(rebased(before.replace("three", "thr33"), selected)).toBeUndefined();
    expect(rebased(before.replace("three\n", ""), selected)).toBeUndefined();
    // Another part of the same line changed: the whole line counts as changed.
    expect(rebased(before.replace("three", "three!"), span(3, 0, 3, 2))).toBeUndefined();
  });

  test("drops a multi-line range when a line was inserted inside it or an end line changed", () => {
    const range = span(2, 0, 4, 4);
    expect(rebased(before.replace("three\n", "three\ninserted\n"), range)).toBeUndefined();
    expect(rebased(before.replace("four", "FOUR"), range)).toBeUndefined();
    expect(rebased(before.replace("two", "TWO"), range)).toBeUndefined();
    expect(rebased(`zero\n${before}`, range)).toEqual(span(3, 0, 5, 4));
  });

  test("moves a linewise range that ends at the start of the next line", () => {
    const range: ResultRange = { ...span(2, 0, 4, 0), linewise: true };
    expect(rebased(`zero\n${before}`, range)).toEqual({ ...span(3, 0, 5, 0), linewise: true });
    // The line after the range is not part of its text.
    expect(rebased(before.replace("four", "FOUR"), range)).toEqual(range);
    expect(rebased(before.replace("three", "THREE"), range)).toBeUndefined();
  });

  test("treats a changed line ending as a changed line", () => {
    expect(rebased(before.replace("three\n", "three\r\n"), selected)).toBeUndefined();
    expect(rebased(before.replace("one\n", "one\r\n"), selected)).toEqual(selected);
    expect(rebased(before.replace("five\n", "five"), span(5, 0, 5, 4))).toBeUndefined();
  });

  test("maps a position after the final line ending", () => {
    expect(rebased(`zero\n${before}`, span(6, 0, 6, 0))).toEqual(span(7, 0, 7, 0));
  });

  test("never relates texts with a lone carriage return", () => {
    expect(createLineMap("a\rb\n", "a\rb\nc\n")).toBeUndefined();
  });

  test("gives up on texts that differ in too many lines", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
    const rewritten = lines.map((line) => `${line} changed`);
    expect(createLineMap(`${lines.join("\n")}\n`, `${rewritten.join("\n")}\n`)).toBeUndefined();
  });

  test("tells identical repeated lines apart by position", () => {
    const repeated = "}\n}\n}\nx\n";
    const map = createLineMap(repeated, `y\n${repeated}`);
    expect([1, 2, 3, 4].map((line) => map?.newLine(line))).toEqual([2, 3, 4, 5]);
  });
});

describe("relocating a range whose lines changed", () => {
  const range = span(2, 0, 4, 4);
  const adjusted = (value: ResultRange): ResultRange => ({ ...value, adjusted: true });

  test("keeps the region when a line inside it changed", () => {
    expect(relocated(before.replace("three", "THREE"), range)).toEqual(adjusted(range));
    expect(relocated(`zero\n${before.replace("three", "THREE")}`, range)).toEqual(
      adjusted(span(3, 0, 5, 4)),
    );
  });

  test("reaches over a changed edge line to the nearest unchanged line", () => {
    expect(relocated(before.replace("two", "TWO"), range)).toEqual(adjusted(range));
    expect(relocated(before.replace("two\n", "a\nb\n"), range)).toEqual(adjusted(span(2, 0, 5, 4)));
    expect(relocated(before.replace("four", "4a\n4b"), range)).toEqual(adjusted(span(2, 0, 6, 0)));
    expect(relocated(before.replace("five\n", "5x\n"), span(4, 0, 5, 4))).toEqual(
      adjusted(span(4, 0, 6, 0)),
    );
  });

  test("includes lines added inside the region", () => {
    expect(relocated(before.replace("three\n", "three\nnew\n"), range)).toEqual(
      adjusted(span(2, 0, 5, 4)),
    );
  });

  test("keeps a whole-line range whole-line", () => {
    const lines = { ...span(2, 0, 5, 0), linewise: true };
    expect(relocated(before.replace("three", "THREE"), lines)).toEqual(adjusted(lines));
  });

  test("finds no region when none of its lines survive", () => {
    expect(relocated(before.replace("three", "thr33"), span(3, 0, 3, 5))).toBeUndefined();
    expect(relocated(before.replace("three\nfour", "3\n4"), span(3, 0, 4, 4))).toBeUndefined();
  });

  test("moves a range whose text is unchanged without marking it", () => {
    const map = createLineMap(before, `zero\n${before}`);
    if (map === undefined) throw new Error("No line map");
    expect(moveRange(range, map, () => [])).toEqual(span(3, 0, 5, 4));
  });
});
