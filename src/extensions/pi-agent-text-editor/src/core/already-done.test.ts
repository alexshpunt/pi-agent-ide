import { expect, test } from "vitest";
import {
  ALREADY_DONE_TEXT,
  alreadyDoneTargets,
  alreadyDoneToolResult,
  describeAlreadyDone,
  isAlreadyDone,
} from "./already-done.ts";

const before = "call_a(x);\nFuncA(y);\nFuncA(z); call_a(w);\n";
const renames = [
  { from: 0, to: 6, insert: "FuncA" },
  { from: 11, to: 16, insert: "FuncA" },
  { from: 21, to: 26, insert: "FuncA" },
  { from: 31, to: 37, insert: "FuncA" },
];

test("a change is already done when its range holds its text", () => {
  expect(renames.map((change) => isAlreadyDone(before, change))).toEqual([
    false,
    true,
    true,
    false,
  ]);
});

test("already-done targets are reported at their 1-based positions after the other changes", () => {
  expect(alreadyDoneTargets(before, renames)).toEqual([
    { lineNumber: 2, column: 1 },
    { lineNumber: 3, column: 1 },
  ]);
  expect(alreadyDoneTargets("x call_a", [{ from: 2, to: 8, insert: "call_a" }])).toEqual([
    { lineNumber: 1, column: 3 },
  ]);
});

test("the description names every listed position and counts the rest", () => {
  expect(describeAlreadyDone([])).toBeUndefined();
  expect(describeAlreadyDone([{ lineNumber: 2, column: 1 }])).toBe(
    "Already had this text, left as is: 1 target at line:column 2:1.",
  );
  const many = Array.from({ length: 52 }, (_, index) => ({ lineNumber: index + 1, column: 1 }));
  expect(describeAlreadyDone(many)).toMatch(
    /: 52 targets at line:column 1:1, .*, 50:1 and 2 more\.$/,
  );
});

test("an edit whose every target is already done succeeds without a write", () => {
  const result = alreadyDoneToolResult(
    [{ edits: new Map([["/workspace/a.cpp", { changes: renames.slice(1, 3) }]]) }],
    new Map([["/workspace/a.cpp", before]]),
  );
  expect(result.details.effect).toBe("not-applied");
  expect(result.content).toEqual([
    {
      type: "text",
      text: `${ALREADY_DONE_TEXT}\n/workspace/a.cpp: Already had this text, left as is: 2 targets at line:column 2:1, 3:1.`,
    },
  ]);
  expect(result.details.results?.[0]?.data).toMatchObject({ ok: true, afterContent: before });
});
