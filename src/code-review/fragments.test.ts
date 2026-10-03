import { expect, test } from "vitest";
import { reviewFragments } from "./fragments.js";

test("reviews separate small diffs with nearby lines, not unrelated file contents", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`);
  const before = lines.join("");
  lines[4] = "first change\n";
  lines[34] = "second change\n";
  const fragments = reviewFragments(before, lines.join(""));
  expect(fragments).toHaveLength(2);
  expect(fragments[0]?.diff).toContain("-line 5\n+first change");
  expect(fragments[0]?.diff).toContain(" line 2");
  expect(fragments[0]?.diff).not.toContain("line 20");
  expect(fragments[1]?.diff).toContain("+second change");
});

test("includes removed code even for a deletion at the end of the file", () => {
  expect(reviewFragments("keep\nremove\n", "keep\n")[0]?.diff).toContain("-remove");
});

test("unchanged files produce no review", () => {
  expect(reviewFragments("same\n", "same\n")).toEqual([]);
});

test("rejects oversized fragments rather than silently reviewing clipped code", () => {
  expect(() => reviewFragments("", "x".repeat(20_000))).toThrow(/large/i);
});
