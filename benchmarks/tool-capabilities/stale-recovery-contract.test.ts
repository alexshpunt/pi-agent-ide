import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

void test("stale Insert recovery permits repaired intermediate edits and preserves its required steps", () => {
  const task = capabilityCases.find(({ id }) => id === "stale-insert-recovery");
  assert.ok(task);
  const old = "024d21fe-92e8-4fc3-9677-baf1eecaea3c";
  const fresh = "997efc4c-4baf-4f3b-bf19-a8d468bc3a3c";
  const calls: {
    tool: string;
    args: Record<string, unknown>;
    text?: string;
    error?: boolean;
    finalText?: string;
    finalDetails?: unknown;
  }[] = [
    {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: `<uuid>${old}</uuid>\nD07BBXQ|OLD`,
    },
    {
      tool: "replace",
      args: { path: JSON.stringify({ id: old }), start: "D07BBXQ|OLD", text: "D07BBXQ|NEW" },
    },
    { tool: "replace", args: { path: "task.txt", start: "D07BBXQ|NEW", text: "NEW" } },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: "D07BBXQ", text: "BLOCKED" },
      error: true,
      text: "D07BBXQ",
    },
    {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: `<uuid>${fresh}</uuid>\nB44PGG9|NEW`,
    },
    {
      tool: "insert",
      args: { path: "task.txt", anchor: "B44PGG9", text: "RECOVERED\n" },
    },
  ];
  const check = (input: typeof calls) => {
    const events: RunEvent[] = input.flatMap((call, index) => [
      {
        type: "tool_execution_start",
        toolCallId: String(index),
        toolName: call.tool,
        args: call.args,
      },
      {
        type: "tool_execution_end",
        toolCallId: String(index),
        toolName: call.tool,
        isError: call.error ?? false,
        result: { content: [{ type: "text", text: call.text ?? "" }] },
      },
    ]);
    input.forEach((call, index) =>
      events.push({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: String(index),
          isError: call.error ?? false,
          content: [{ type: "text", text: call.finalText ?? call.text ?? "" }],
          ...(call.error && {
            details: call.finalDetails ?? { guardId: "stale-anchor", effect: "not-applied" },
          }),
        },
      }),
    );
    return validateRoute(task, events, "direct").passed;
  };
  assert.ok(check(calls));
  assert.ok(
    !check(
      calls.map((call, index) =>
        index === 3 ? { ...call, finalText: "different-outcome" } : call,
      ),
    ),
  );
  assert.ok(
    !check(
      calls.map((call, index) =>
        index === 3 ? { ...call, finalDetails: { guardId: "other", effect: "not-applied" } } : call,
      ),
    ),
  );
  assert.ok(!check(calls.filter(({ tool }) => tool !== "replace")));
  assert.ok(!check(calls.filter((_, index) => index !== 3)));
  assert.ok(!check(calls.filter((_, index) => index !== 4)));
  assert.ok(!check(calls.map((call, index) => (index === 3 ? { ...call, error: false } : call))));
  assert.ok(
    !check(
      calls.map((call, index) =>
        index === 5 ? { ...call, args: { ...call.args, anchor: "D07BBXQ" } } : call,
      ),
    ),
  );
});
