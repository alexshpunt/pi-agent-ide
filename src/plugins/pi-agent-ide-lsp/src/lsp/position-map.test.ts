import { expect, test } from "vitest";

import { LinePositionMap } from "./position-map.ts";

const range = (startLine: number, endLine: number, start = 0, end = 1) => ({
  start: { line: startLine, character: start },
  end: { line: endLine, character: end },
});

const served = ["a", "b", "int f() {", "  return 1;", "}", "c", "d", ""].join("\n");

test("a range moves with its unchanged lines past edits above and below it", () => {
  const current = ["inserted", "a", "b", "int f() {", "  return 1;", "}", "c", "changed", ""].join(
    "\n",
  );

  expect(LinePositionMap.between(served, current).mapRange(range(2, 4, 4, 1))).toEqual(
    range(3, 5, 4, 1),
  );
});

test("a range whose own lines changed has no current position", () => {
  const current = ["a", "b", "int f() {", "  return 2;", "}", "c", "d", ""].join("\n");
  const map = LinePositionMap.between(served, current);

  expect(map.mapRange(range(2, 4))).toBeUndefined();
  expect(map.mapRange(range(5, 6))).toEqual(range(5, 6));
});

test("an unchanged text keeps every range", () => {
  expect(LinePositionMap.between(served, served).mapRange(range(3, 3, 2, 8))).toEqual(
    range(3, 3, 2, 8),
  );
});
