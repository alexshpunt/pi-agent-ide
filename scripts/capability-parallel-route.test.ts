import { expect, test } from "vitest";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const start = (id: string, parent = "script"): RunEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  parentToolCallId: parent,
  toolName: "insert",
});
const end = (id: string): RunEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "insert",
  isError: false,
});
const parent: RunEvent = {
  type: "tool_execution_start",
  toolName: "codemode",
  toolCallId: "script",
};
const route = { steps: [{ tool: "insert" }, { tool: "insert", parallelWith: 0 }] };

test("parallel capability evidence rejects sequential calls", () => {
  expect(
    validateRoute(
      route,
      [parent, start("first"), end("first"), start("last"), end("last")],
      "codemode",
    ).passed,
  ).toBe(false);
});

test("parallel capability evidence accepts overlapping calls in one script", () => {
  expect(
    validateRoute(
      route,
      [parent, start("first"), start("last"), end("first"), end("last")],
      "codemode",
    ),
  ).toEqual({ passed: true, reasons: [] });
});

test("separate Codemode parents do not establish same-script concurrency", () => {
  const other = { ...parent, toolCallId: "other" };
  expect(
    validateRoute(
      route,
      [parent, other, start("first"), start("last", "other"), end("first"), end("last")],
      "codemode",
    ).passed,
  ).toBe(false);
});

test("failed completions do not establish parallel success", () => {
  expect(
    validateRoute(
      route,
      [parent, start("first"), start("last"), end("first"), { ...end("last"), isError: true }],
      "codemode",
    ).passed,
  ).toBe(false);
});
