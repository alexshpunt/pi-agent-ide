import { expect, test } from "vitest";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

test.each([
  { batches: [{ applied: true, calls: [{ id: "edit" }, { id: "peer" }] }], passed: true },
  { batches: [{ applied: true, calls: [{ id: "edit" }] }], passed: false },
  { batches: [{ applied: false, calls: [{ id: "edit" }, { id: "peer" }] }], passed: false },
  { batches: [{ applied: true, calls: [{ id: "other" }, { id: "peer" }] }], passed: false },
  { batches: undefined, passed: false },
])("native batch capability checks committed child membership: $passed", ({ batches, passed }) => {
  const events: RunEvent[] = [
    { type: "tool_execution_start", toolCallId: "script", toolName: "codemode" },
    {
      type: "tool_execution_start",
      toolCallId: "edit",
      parentToolCallId: "script",
      toolName: "replace",
    },
    { type: "tool_execution_end", toolCallId: "edit", toolName: "replace", isError: false },
    {
      type: "tool_execution_end",
      toolCallId: "script",
      toolName: "codemode",
      isError: false,
      result: { details: { editorBatches: batches } },
    },
  ];
  expect(
    validateRoute({ steps: [{ tool: "replace", editorBatchSize: 2 }] }, events, "codemode").passed,
  ).toBe(passed);
});
