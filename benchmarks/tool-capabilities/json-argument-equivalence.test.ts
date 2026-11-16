import { strict as assert } from "node:assert";
import test from "node:test";
import { executionArguments } from "./argument-equivalence.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

const id = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
const other = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: JSON-text argument equivalence retains issued-reference requirements and raw evidence`, () => {
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
      start("read", "read", { path: '[ "a.txt", "b.txt" ]', views: '["anchors"]' }),
      end("read", "read", { content: [{ type: "text", text: id }], structuredContent: { id } }),
      start("search", "search", { path: JSON.stringify({ id }), query: "needle" }),
      end("search", "search"),
      start("diff", "diff", {
        before: '{"path":"a.txt","limit":0}',
        after: '{"limit":0,"path":"b.txt"}',
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
    for (const path of [JSON.stringify({ id: other }), '{"id":', JSON.stringify([id, other])]) {
      const changed = events.map((event) =>
        event.toolCallId === "search" && event.args
          ? { ...event, args: { ...event.args, path } }
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

void test("argument preparation preserves literal payloads, malformed strings and invalid-call strictness", () => {
  const content = '{ "ratio": 1.0, "items": [1, 2] }';
  assert.deepEqual(executionArguments("write", { path: JSON.stringify({ id }), content }), {
    path: { id },
    content,
  });
  assert.deepEqual(executionArguments("search", { path: '["a.txt"]', query: content }), {
    path: ["a.txt"],
    query: content,
  });
  const malformed = { path: '{"id":', query: "needle" };
  assert.deepEqual(executionArguments("search", malformed), malformed);
  const invalid = { path: '{"id":"x"}', views: {} };
  assert.deepEqual(executionArguments("read", invalid), invalid);
  const scalar = { path: '"a.txt"' };
  assert.deepEqual(executionArguments("read", scalar), scalar);
});
