import { expect, test } from "vitest";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const task = {
  steps: [{ tool: "bash" }],
  guideFirstUse: { path: "docs:terminal", tool: "bash" },
};
function call(id: string, tool: string, args: Record<string, unknown>): RunEvent[] {
  return [
    { type: "tool_execution_start", toolCallId: id, toolName: tool, args },
    { type: "tool_execution_end", toolCallId: id, toolName: tool, isError: false },
  ];
}
const guide = call("guide", "read", { path: "docs:terminal" });
const shell = call("shell", "bash", { command: "printf marker" });
const complete = [...guide, ...shell];

test.each(["direct", "codemode"])(
  "accepts full guide retrieval before first shell use through %s",
  (mode) => {
    const events =
      mode === "direct"
        ? complete
        : [
            { type: "tool_execution_start", toolCallId: "parent", toolName: "codemode" },
            ...complete.map((event) => ({ ...event, parentToolCallId: "parent" })),
            {
              type: "tool_execution_end",
              toolCallId: "parent",
              toolName: "codemode",
              isError: false,
            },
          ];
    expect(validateRoute(task, events, mode)).toEqual({ passed: true, reasons: [] });
  },
);

test("keeps guide-path choice separate from native route compliance", () => {
  const events = [
    ...guide,
    { type: "tool_execution_start", toolCallId: "parent", toolName: "codemode" },
    ...shell.map((event) => ({ ...event, parentToolCallId: "parent" })),
    { type: "tool_execution_end", toolCallId: "parent", toolName: "codemode", isError: false },
  ];
  expect(validateRoute(task, events, "codemode").passed).toBe(false);
});
test("rejects a filesystem detour even when the model later retrieves the guide", () => {
  const events = [...call("detour", "read", { path: "~/.pi/agent/docs/terminal.md" }), ...complete];
  expect(validateRoute(task, events, "direct").passed).toBe(false);
});

test("allows status inspection of the returned shell resource", () => {
  expect(
    validateRoute(
      task,
      [...complete, ...call("status", "read", { path: "shell:session" })],
      "direct",
    ).passed,
  ).toBe(true);
});
test("does not let a later guide read hide unguided first shell use", () => {
  expect(
    validateRoute(task, [...shell, ...guide, ...call("again", "bash", {})], "direct").passed,
  ).toBe(false);
});

test("does not count a guide listing as the full guide", () => {
  expect(
    validateRoute(task, [...call("list", "read", { path: "docs:" }), ...shell], "direct").passed,
  ).toBe(false);
  expect(
    validateRoute(task, [...call("list", "read", { path: "docs:" }), ...complete], "direct").passed,
  ).toBe(true);
});

test.each([{ limit: 1 }, { offset: 2 }])("rejects a partial guide read: %j", (paging) => {
  expect(
    validateRoute(
      task,
      [...call("partial", "read", { path: "docs:terminal", ...paging }), ...shell],
      "direct",
    ).passed,
  ).toBe(false);
});

test("rejects failed or unfinished guide retrieval", () => {
  expect(validateRoute(task, [...guide.slice(0, 1), ...shell], "direct").passed).toBe(false);
  expect(
    validateRoute(
      task,
      [
        ...guide.map((event) =>
          event.type === "tool_execution_end" ? { ...event, isError: true } : event,
        ),
        ...shell,
      ],
      "direct",
    ).passed,
  ).toBe(false);
  expect(
    validateRoute(task, [...guide.slice(0, 1), ...shell, ...guide.slice(1)], "direct").passed,
  ).toBe(false);
});
