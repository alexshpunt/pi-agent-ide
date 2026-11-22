import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { issuedAnchor } from "./selection-evidence.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  details?: Record<string, unknown>;
  error?: boolean;
}
const uuid = "11111111-aaaa-4aaa-8aaa-111111111111";
const id = `RESULT#${uuid}`;
const other = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
function events(calls: Call[], mode: string): RunEvent[] {
  const entries: RunEvent[] = calls.flatMap((call, index) => [
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
      isError: call.error ?? false,
      result: {
        content: [{ type: "text", text: call.text ?? "" }],
        structuredContent: call.value,
        details: call.details,
      },
    },
  ]);
  return mode === "direct"
    ? entries
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...entries,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}

void test("display separators retain issued anchor identity without accepting changed copied text", () => {
  const output = `<uuid>${uuid}</uuid>\nD07BBXQ|OLD\nAEW1YNW|last\n`;
  for (const value of ["D07BBXQ", "D07BBXQ|", "D07BBXQ|OLD", "D07BBXQ|OLD\n"])
    assert.equal(issuedAnchor(value, output), "D07BBXQ");
  for (const value of ["123ABCD|", "D07BBXQ|NEW", "D07BBXQ|OLD\nlast"])
    assert.equal(issuedAnchor(value, output), undefined);
});

for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: copied-prefix recovery accepts the issued display separator`, () => {
    const task = capabilityCases.find(({ id }) => id === "copied-line-prefix-recovery");
    assert.ok(task);
    const calls: Call[] = [
      { tool: "read", args: { path: "task.txt", views: ["anchors"] }, text: "D07BBXQ|OLD" },
      {
        tool: "replace",
        args: { path: "task.txt", at: "D07BBXQ|", text: "D07BBXQ|NEW" },
        error: true,
      },
      { tool: "replace", args: { path: "task.txt", at: "D07BBXQ|", text: "NEW" } },
    ];
    assert.ok(validateRoute(task, events(calls, mode), mode).passed);
    for (const start of ["123ABCD|", "D07BBXQ|WRONG"])
      assert.equal(
        validateRoute(
          task,
          events(
            calls.map((call, i) =>
              i === 2 ? { ...call, args: { ...call.args, at: start } } : call,
            ),
            mode,
          ),
          mode,
        ).passed,
        false,
      );
  });

  void test(`${mode}: Write paths require a completed whole-file Read of the same file`, () => {
    const task = {
      files: { "data.json": "[\n1,2\n]\n" },
      steps: [
        { tool: "read" },
        { tool: "write", args: { path: "data.json", content: "[1,3]\n" }, after: [0] },
      ],
    };
    const read: Call = {
      tool: "read",
      args: { path: "/workspace/fixture/data.json" },
      text: `<uuid>${uuid}</uuid>\n[\n1,2\n]\n`,
      value: { id, text: "[\n1,2\n]\n" },
    };
    const write = (path: unknown): Call => ({ tool: "write", args: { path, content: "[1,3]\n" } });
    const check = (calls: Call[]) => validateRoute(task, events(calls, mode), mode).passed;
    for (const path of [uuid, id, { id: uuid }, { id }, read.value])
      assert.ok(check([read, write(path)]), JSON.stringify(path));
    // JSON text is a literal path, not a result reference.
    for (const path of [
      JSON.stringify({ id: uuid }),
      JSON.stringify({ id }),
      other,
      { id: other },
      JSON.stringify({ id: other }),
      '{"id":',
      [id, other],
    ])
      assert.equal(check([read, write(path)]), false, JSON.stringify(path));
    assert.equal(check([{ ...read, text: `${read.text}\n${other}` }, write({ id: other })]), false);
    for (const changed of [
      { ...read, error: true },
      { ...read, args: { path: "other.json" } },
      { ...read, args: { path: "data.json", offset: 2 } },
      { ...read, args: { path: "data.json", limit: 1 } },
      { ...read, args: { path: "data.json", views: ["jq:.[0]"] } },
      { ...read, tool: "search", args: { path: "data.json", query: "1" } },
    ])
      assert.equal(check([changed, write({ id })]), false, JSON.stringify(changed.args));
    const missingEnd = events([read, write({ id })], mode).filter(
      (event) => event.toolCallId !== "0" || event.type !== "tool_execution_end",
    );
    assert.equal(validateRoute(task, missingEnd, mode).passed, false);
    assert.equal(check([write({ id }), read]), false);

    // Reading a bounded result again must not turn it into whole-file authority.
    assert.equal(
      check([
        { ...read, args: { path: "data.json", limit: 1 } },
        { ...read, args: { path: { id } }, value: { id: other }, text: other },
        write({ id: other }),
      ]),
      false,
    );
    // A recorded window covering every source line is still the whole file.
    assert.ok(
      check([
        {
          ...read,
          args: { path: "data.json", limit: 10 },
          details: { startLine: 1, endLine: 3, totalLines: 3 },
        },
        write({ id }),
      ]),
    );
  });
}
