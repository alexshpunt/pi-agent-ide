import { describe, expect, test } from "vitest";
import {
  createLineMap,
  createRangeTracker,
  describeLostRange,
  moveRange,
  rebaseOrRelocateRange,
  rebaseRange,
  rangesInText,
  relocateRange,
} from "./line-map.ts";
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

describe("matches inside changed lines", () => {
  const code = [
    "int a = 1;",
    "if (call_dot(pNrm, pIn) * call_dot(pNrm, pOut) <= 0) return 0;",
    "int b = 2;",
    "",
  ].join("\n");
  const first = span(2, 4, 2, 12);
  const second = span(2, 26, 2, 34);

  function relocated(after: string, range: ResultRange): ResultRange | undefined {
    const map = createLineMap(code, after);
    return map === undefined ? undefined : rebaseOrRelocateRange(range, map);
  }

  test("follows a match when another part of its line changed", () => {
    const after = code.replace("pNrm, pIn", "pNormal, pIn").replace("pNrm, pOut", "pNormal, pOut");
    expect(relocated(after, first)).toEqual(span(2, 4, 2, 12));
    expect(relocated(after, second)).toEqual(span(2, 29, 2, 37));
  });

  test("follows a match when its line moved and changed at once", () => {
    const after = `new\n${code.replace("pIn", "p_incoming")}`;
    expect(relocated(after, first)).toEqual(span(3, 4, 3, 12));
  });

  test("follows a match into the lines that replaced its line", () => {
    const after = code.replace("if (call_dot(pNrm, pIn)", "// note\nif (call_dot(pNrm, pIn)");
    expect(relocated(after, first)).toEqual(span(3, 4, 3, 12));
  });

  test("keeps the same copy when several copies share the line", () => {
    const after = code.replace("<= 0", "< 1");
    expect(relocated(after, second)).toEqual(span(2, 26, 2, 34));
  });

  test("drops a match when the number of copies of its text changed", () => {
    expect(
      relocated(code.replace("call_dot(pNrm, pOut)", "other(pNrm, pOut)"), first),
    ).toBeUndefined();
    expect(relocated(code.replace("if (", "call_dot(x); if ("), first)).toBeUndefined();
  });

  test("drops a match when the text next to it changed", () => {
    expect(
      relocated(code.replace("call_dot(pNrm, pIn)", "call_dot2(pNrm, pIn)"), first),
    ).toBeUndefined();
    expect(relocated(code.replace("if (call_dot", "if (!call_dot"), first)).toBeUndefined();
  });

  test("drops a match whose line was deleted and reports where it stood", () => {
    const after = code.replace(/if .*\n/u, "");
    const map = createLineMap(code, after);
    expect(map === undefined ? undefined : rebaseOrRelocateRange(first, map)).toBeUndefined();
    expect(describeLostRange(first, map)).toContain("line 2");
    expect(describeLostRange(first, map)).toContain("deleted");
  });

  test("reports the lines that replaced a changed line", () => {
    const map = createLineMap(code, code.replace("call_dot", "CallDot"));
    expect(describeLostRange(first, map)).toContain("2| if (CallDot(pNrm, pIn)");
  });

  test("never moves a linewise or a multi-line range by its text", () => {
    const after = code.replace("pIn", "p_incoming");
    expect(relocated(after, { ...span(2, 0, 3, 0), linewise: true })).toBeUndefined();
    expect(relocated(after, span(2, 4, 3, 3))).toBeUndefined();
  });
});

describe("tracking selections after a block move", () => {
  const block = Array.from({ length: 1000 }, (_, index) => `int moved_${index};`);
  const middle = Array.from({ length: 1200 }, (_, index) => `int kept_${index};`);
  const file = (...parts: string[][]) => [...parts.flat(), ""].join("\n");

  test("follows both the moved block and the text it crossed when the diff exceeds its budget", () => {
    const before = file(block, middle);
    const after = file(middle, block);
    const inside = { ...span(500, 0, 505, 0), linewise: true };
    const crossed = span(1100, 4, 1100, 12);
    expect(rangesInText([inside, crossed], before, after)).toEqual([
      { ...span(1700, 0, 1705, 0), linewise: true },
      span(100, 4, 100, 12),
    ]);
  });

  test("uses surrounding lines to distinguish identical matches in moved blocks", () => {
    const a = ["void a() {", "  call(oldName);", "  finish_a();", "}"];
    const b = ["void b() {", "  call(oldName);", "  finish_b();", "}"];
    const before = file(a, middle, b);
    const after = file(b, middle, a);
    expect(rangesInText([span(2, 7, 2, 14)], before, after)).toEqual([span(1206, 7, 1206, 14)]);
  });

  test("follows a match when a peer also changed an identifier earlier on the moved line", () => {
    const edited = block.with(499, "return previous_name(old_arg);");
    const before = file(edited, middle);
    const after = file(middle, edited.with(499, "return new_name(old_arg);"));
    expect(rangesInText([span(500, 21, 500, 28)], before, after)).toEqual([
      span(1700, 16, 1700, 23),
    ]);
  });

  test("follows a partial match through a moved stretch that gained a line", () => {
    const edited = block.with(499, "return previous_name(old_arg);");
    const changed = [
      ...edited.slice(0, 499),
      "log();",
      "return new_name(old_arg);",
      ...edited.slice(500),
    ];
    expect(
      rangesInText([span(500, 21, 500, 28)], file(edited, middle), file(middle, changed)),
    ).toEqual([span(1701, 16, 1701, 23)]);
  });

  test("can read an adjusted region when unrelated lines swapped", () => {
    const before = "left\nupdated\nright\na\nb\n";
    const after = "left\nchanged\nright\nb\na\n";
    const range = { ...span(1, 0, 4, 0), linewise: true };
    const tracker = createRangeTracker(before, after);
    expect(tracker.move(range)).toBeUndefined();
    expect(tracker.move(range, true)).toEqual({ ...range, adjusted: true });
  });

  test("does not jump to an unchanged copy when the selected copy was rewritten", () => {
    const a = ["void a() {", "  call(oldName);", "}"];
    const b = ["void b() {", "  call(oldName);", "}"];
    const before = file(a, middle, b);
    const after = file(b, middle, a.with(1, "  call(newName);"));
    expect(rangesInText([span(2, 7, 2, 14)], before, after)).toBeUndefined();
  });

  test("does not follow a formerly unique range into either of two identical copies", () => {
    const before = file(block, middle);
    const after = file(middle, block, block);
    expect(rangesInText([span(500, 4, 500, 13)], before, after)).toBeUndefined();
  });

  test("follows selected text across the end of a file without a trailing newline", () => {
    const before = [...middle, ...block].join("\n");
    const after = [...block, ...middle].join("\n");
    const length = "int moved_999;".length;
    expect(rangesInText([span(2200, 0, 2200, length)], before, after)).toEqual([
      span(1000, 0, 1000, length),
    ]);
    expect(rangesInText([span(1200, 0, 1201, 0)], before, after)).toBeUndefined();
  });

  test("does not pair duplicate matches by order inside a changed stretch of a moved block", () => {
    const edited = block.with(499, "first(old_arg);").with(500, "second(old_arg);");
    const changed = edited
      .with(499, "renamed_second(old_arg);")
      .with(500, "renamed_first(old_arg);");
    expect(
      rangesInText([span(500, 6, 500, 13)], file(edited, middle), file(middle, changed)),
    ).toBeUndefined();
  });

  test("reports possible match locations beyond the preview of a changed moved stretch", () => {
    const edited = block.with(499, "first(old_arg);").with(500, "second(old_arg);");
    const changed = [
      ...edited.slice(0, 499),
      "log_a();",
      "log_b();",
      "log_c();",
      "renamed_second(old_arg);",
      "renamed_first(old_arg);",
      ...edited.slice(501),
    ];
    const tracker = createRangeTracker(file(edited, middle), file(middle, changed));
    const range = span(500, 6, 500, 13);
    expect(tracker.move(range)).toBeUndefined();
    const locations = tracker.describe(range).match(/\b\d+\b/gu);
    expect(locations).toEqual(expect.arrayContaining(["1703", "1704"]));
  });
  test("does not join the pieces of a selection split by a move", () => {
    const before = file(block, middle);
    const after = file(middle, block);
    expect(rangesInText([span(999, 0, 1002, 0)], before, after)).toBeUndefined();
  });
});
