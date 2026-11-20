import { strict as assert } from "node:assert";
import test from "node:test";
import { executionArguments, sourceValues } from "./argument-equivalence.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

const id = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
const other = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: structured argument equivalence retains issued-reference requirements and raw evidence`, () => {
    const start = (
      toolName: string,
      toolCallId: string,
      args: Record<string, unknown>,
    ): RunEvent => ({
      type: "tool_execution_start",
      toolName,
      toolCallId,
      args,
      ...(mode === "codemode" && { parentToolCallId: "script" }),
    });
    const end = (toolName: string, toolCallId: string, result = {}): RunEvent => ({
      type: "tool_execution_end",
      toolName,
      toolCallId,
      isError: false,
      result,
    });
    const steps = [
      { tool: "read", args: { path: ["a.txt", "b.txt"], views: ["anchors"] } },
      {
        tool: "search",
        args: { path: { id }, query: "needle" },
        reuse: { from: 0, field: "path" },
      },
      {
        tool: "diff",
        args: { before: { path: "a.txt", limit: 0 }, after: { path: "b.txt", limit: 0 } },
      },
    ];
    const entries = [
      start("read", "read", { path: ["a.txt", "b.txt"], views: '["anchors"]' }),
      end("read", "read", { content: [{ type: "text", text: id }], structuredContent: { id } }),
      start("search", "search", { path: { id }, query: "needle" }),
      end("search", "search"),
      start("diff", "diff", {
        before: { path: "a.txt", limit: 0 },
        after: { limit: 0, path: "b.txt" },
      }),
      end("diff", "diff"),
    ];
    const events =
      mode === "direct"
        ? entries
        : [start("codemode", "script", {}), ...entries, end("codemode", "script")];
    const original = structuredClone(events);
    assert.ok(validateRoute({ steps }, events, mode).passed);
    assert.deepEqual(events, original);
    for (const path of [
      { id: other },
      JSON.stringify({ id }),
      '{"id":',
      JSON.stringify([id, other]),
    ]) {
      const changed = events.map((event) =>
        event.toolCallId === "search" && event.args
          ? { ...event, args: { ...event.args, path } }
          : event,
      );
      assert.equal(validateRoute({ steps }, changed, mode).passed, false);
    }
    for (const toolCallId of ["read", "diff"]) {
      const changed = events.map((event) =>
        event.toolCallId === toolCallId && event.args
          ? {
              ...event,
              args: Object.fromEntries(
                Object.entries(event.args).map(([key, value]) => [
                  key,
                  typeof value === "object" ? JSON.stringify(value) : value,
                ]),
              ),
            }
          : event,
      );
      assert.equal(validateRoute({ steps }, changed, mode).passed, false);
    }
    assert.equal(
      validateRoute(
        { steps },
        events.filter(
          (event) => event.type !== "tool_execution_end" || event.toolCallId !== "read",
        ),
        mode,
      ).passed,
      false,
    );
  });
}

void test("context-free argument comparison does not guess JSON source recovery or parse selectors", () => {
  const literal = '{ "id": "checkout-5", "ratio": 1.0, "items": [1, 2] }';
  for (const [name, args] of [
    ["write", { path: JSON.stringify({ id }), content: literal }],
    ["search", { path: '["a.txt"]', query: literal }],
    ["replace", { path: "data.json", start: literal, end: literal, text: "{}" }],
    ["insert", { path: "data.json", anchor: literal, text: " " }],
    [
      "copy",
      {
        path: "source.json",
        start: literal,
        end: literal,
        target: "target.json",
        targetStart: literal,
        targetEnd: literal,
      },
    ],
    ["diff", { before: literal, after: literal }],
  ] as const) {
    assert.deepEqual(executionArguments(name, args), args);
  }
  assert.deepEqual(sourceValues(literal), [literal]);
  assert.deepEqual(sourceValues('["a.txt","b.txt"]'), ['["a.txt","b.txt"]']);
  assert.deepEqual(sourceValues(JSON.stringify({ id })), [JSON.stringify({ id })]);
  assert.deepEqual(sourceValues({ id }), [id]);
  assert.deepEqual(sourceValues([{ id }, literal]), [id, literal]);
});

void test("argument preparation retains array-only decoding, native values and invalid-call strictness", () => {
  assert.deepEqual(executionArguments("read", { path: [{ id }, "a.txt"], views: '["anchors"]' }), {
    path: [{ id }, "a.txt"],
    views: ["anchors"],
  });
  const malformed = { path: '{"id":', query: "needle" };
  assert.deepEqual(executionArguments("search", malformed), malformed);
  const invalid = { path: { id: "x" }, views: {} };
  assert.deepEqual(executionArguments("read", invalid), invalid);
  const scalar = { path: '"a.txt"' };
  assert.deepEqual(executionArguments("read", scalar), scalar);
});
