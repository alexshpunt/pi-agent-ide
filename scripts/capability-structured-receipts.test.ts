import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { validateRoute, type RouteStep, type RunEvent } from "#capabilities/validation.ts";

const aliases = { mcp__agent_ide__insert: "insert" };
function fixture(effect: "applied" | "not-applied" | "unknown" = "applied") {
  const receipt = { effect, nonce: randomUUID(), receipt: { attempted: 1 } };
  const isError = effect !== "applied";
  const result = {
    content: [{ type: "text", text: `Semantic action ${effect}.` }],
    structuredContent: receipt,
  };
  const step: RouteStep = {
    tool: "insert",
    error: isError,
    parentStructuredValue: true,
    viaLocalAlias: true,
  };
  const events: RunEvent[] = [
    { type: "tool_execution_start", toolCallId: "parent", toolName: "codemode" },
    {
      type: "tool_execution_start",
      toolCallId: "alias",
      parentToolCallId: "parent",
      toolName: "mcp__agent_ide__insert",
      args: { path: `fixture:semantic-script/${effect}`, text: "probe" },
    },
    {
      type: "tool_execution_start",
      toolCallId: "source",
      parentToolCallId: "alias",
      toolName: "insert",
      args: { path: `fixture:semantic-script/${effect}`, text: "probe" },
    },
    { type: "tool_execution_end", toolCallId: "source", isError, result },
    { type: "tool_execution_end", toolCallId: "alias", isError, result },
    {
      type: "tool_execution_end",
      toolCallId: "parent",
      isError: false,
      result: { content: [{ type: "text", text: "Script completed\n" + JSON.stringify(receipt) }] },
    },
  ];
  return { receipt, events, task: { steps: [step] } };
}

test.each(["applied", "not-applied", "unknown"] as const)(
  "a completed native parent preserves the structured %s receipt through an evidenced alias",
  (effect) => {
    const { events, task } = fixture(effect);
    const original = structuredClone(events);
    expect(validateRoute(task, events, "codemode", aliases).passed).toBe(true);
    expect(validateRoute(task, events, "codemode").passed).toBe(false);
    expect(events).toEqual(original);
  },
);

test("a canonical Insert cannot stand in for a required local alias", () => {
  const { events, task } = fixture();
  const direct = events
    .filter((event) => event.toolCallId !== "alias")
    .map((event) =>
      event.parentToolCallId === "alias" ? { ...event, parentToolCallId: "parent" } : event,
    );
  expect(validateRoute(task, direct, "codemode").passed).toBe(false);
  const native = { steps: task.steps.map((step) => ({ ...step, viaLocalAlias: false })) };
  expect(validateRoute(native, direct, "codemode").passed).toBe(true);
});

test.each(["summary", "quoted-json", "invented-receipt"] as const)(
  "the parent's %s is not the actual structured object",
  (output) => {
    const { receipt, events, task } = fixture();
    const text =
      output === "summary"
        ? "Semantic action applied: object"
        : output === "quoted-json"
          ? JSON.stringify(JSON.stringify(receipt))
          : JSON.stringify({ ...receipt, nonce: randomUUID() });
    events[5] = {
      ...events[5],
      type: "tool_execution_end",
      result: { content: [{ type: "text", text }] },
    };
    expect(validateRoute(task, events, "codemode", aliases).passed).toBe(false);
  },
);

test.each(["missing-value", "string-value", "alias-drops-value"] as const)(
  "%s cannot establish structured forwarding",
  (change) => {
    const { receipt, events, task } = fixture();
    for (const index of change === "alias-drops-value" ? [4] : [3, 4]) {
      const event = events[index];
      if (!event?.result) throw new Error("Missing fixture result");
      events[index] = {
        ...event,
        result: {
          ...event.result,
          structuredContent: change === "string-value" ? JSON.stringify(receipt) : undefined,
        },
      };
    }
    expect(validateRoute(task, events, "codemode", aliases).passed).toBe(false);
  },
);

test.each(["missing", "failed", "ended-early", "started-late"] as const)(
  "a %s native parent cannot prove the script received its child value",
  (change) => {
    const { events, task } = fixture();
    if (change === "missing") events.pop();
    if (change === "failed")
      events[5] = { ...events[5], type: "tool_execution_end", isError: true };
    if (change === "ended-early") events.splice(1, 0, ...events.splice(5, 1));
    if (change === "started-late") events.splice(3, 0, ...events.splice(0, 1));
    expect(validateRoute(task, events, "codemode", aliases).passed).toBe(false);
  },
);
