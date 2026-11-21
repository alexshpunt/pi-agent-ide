import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

for (const mode of ["direct", "codemode"]) {
  void test(`JSON-selector capability requires text selectors and a literal JSON filename (${mode})`, () => {
    const task = capabilityCases.find((candidate) => candidate.id === "json-literal-selectors");
    assert.ok(task);
    const literal = '{"id":"checkout-5","feature":"legacyCheckout","retries":3}';
    const stable = literal.replace("legacyCheckout", "stableCheckout");
    const filename = '["a.txt","b.txt"]';
    const calls: Array<{ tool: string; args: Record<string, unknown>; text?: string }> = [
      { tool: "read", args: { path: filename }, text: "LITERAL-PATH-MARKER" },
      {
        tool: "read",
        args: { path: ["replace.json", "insert.json", "source.json", "target.json"] },
      },
      {
        tool: "replace",
        args: { path: "replace.json", from: literal, through: literal, text: stable },
      },
      { tool: "insert", args: { path: "insert.json", before: literal, text: " " } },
      {
        tool: "copy",
        args: {
          path: "source.json",
          from: stable,
          through: stable,
          target: "target.json",
          targetFrom: literal,
          targetThrough: literal,
        },
      },
    ];
    const check = (input: typeof calls) => {
      const events: RunEvent[] = input.flatMap((call, index) => [
        {
          type: "tool_execution_start",
          toolCallId: String(index),
          toolName: call.tool,
          args: call.args,
          ...(mode === "codemode" && { parentToolCallId: "script" }),
        },
        {
          type: "tool_execution_end",
          toolCallId: String(index),
          toolName: call.tool,
          isError: false,
          result: { content: [{ type: "text", text: call.text ?? "" }] },
        },
      ]);
      if (mode === "codemode") {
        events.unshift({
          type: "tool_execution_start",
          toolCallId: "script",
          toolName: "codemode",
        });
        events.push({
          type: "tool_execution_end",
          toolCallId: "script",
          toolName: "codemode",
          isError: false,
        });
      }
      return validateRoute(task, events, mode).passed;
    };
    assert.ok(check(calls));
    assert.ok(
      !check(
        calls.map((call, index) =>
          index === 0 ? { ...call, args: { path: ["a.txt", "b.txt"] } } : call,
        ),
      ),
    );
    for (const [index, fields] of [
      [2, ["from", "through"]],
      [3, ["before"]],
      [4, ["from", "through", "targetFrom", "targetThrough"]],
    ] as const) {
      for (const field of fields) {
        for (const value of [
          "legacyCheckout",
          { id: "RESULT#11111111-aaaa-4aaa-8aaa-111111111111" },
        ]) {
          const changed = calls.map((call, number) =>
            number === index ? { ...call, args: { ...call.args, [field]: value } } : call,
          );
          assert.ok(!check(changed));
        }
      }
    }
  });
}
