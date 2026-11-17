import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateFiles } from "./sandbox.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  value?: unknown;
  text?: string;
  error?: boolean;
}
const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const first = "function first() { return 7; }";
const second = "function second() { return 9; }";
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}
const enclosing = required(capabilityCases.find(({ id }) => id === "ast-search-enclosing"));
const capture = required(capabilityCases.find(({ id }) => id === "ast-capture-rename"));

function result(mode: string, index: number, text: string, source = "task.ts") {
  const id = `RESULT#${ids[index]}`;
  return mode === "codemode"
    ? { id, complete: true, matches: [{ path: source, line: 2, text, lineText: second, id }] }
    : {
        data: {
          kind: "matches",
          target: id,
          complete: true,
          matches: [{ source, matchedText: text, target: id, range: { startLine: 2, endLine: 2 } }],
        },
      };
}
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
      result: { content: [{ type: "text", text: call.text ?? "" }], structuredContent: call.value },
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
function chain(mode: string, scope: unknown = "."): Call[] {
  return [
    {
      tool: "search",
      args: { path: scope, query: "return 9", include: "task.ts" },
      value: result(mode, 0, "return 9"),
      text: `<uuid>${ids[0]}</uuid>\nreturn 9`,
    },
    {
      tool: "ast_search",
      args: {
        path: { id: `RESULT#${ids[0]}` },
        relation: "enclosing",
        language: "typescript",
        rule: { kind: "function_declaration" },
      },
      value: result(mode, 1, second),
      text: `<uuid>${ids[1]}</uuid>\n${second}`,
    },
    {
      tool: "replace",
      args: { path: { id: `RESULT#${ids[1]}` }, text: second.replace("9", "10") },
    },
  ];
}
function data(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return (record.data ?? record) as Record<string, unknown>;
}

for (const mode of ["direct", "codemode"]) {
  const check = (calls: Call[]) => validateRoute(enclosing, events(calls, mode), mode).passed;
  void test(`${mode}: enclosing composition accepts equivalent issued selections across request scopes`, () => {
    for (const scope of ["task.ts", ".", [".", "other"]]) assert.ok(check(chain(mode, scope)));
    const calls = chain(mode);
    required(calls[1]).args.path = required(calls[0]).value;
    required(calls[2]).args.path = required(calls[1]).value;
    assert.ok(check(calls));
  });

  void test(`${mode}: enclosing composition checks the complete issued match list`, () => {
    for (const index of [0, 1]) {
      const valid = chain(mode, "task.ts");
      const original = data(required(valid[index]).value);
      const match = required((original.matches as Record<string, unknown>[])[0]);
      const textKey = mode === "codemode" ? "text" : "matchedText";
      const pathKey = mode === "codemode" ? "path" : "source";
      for (const changed of [
        { ...original, complete: false },
        { ...original, truncated: true },
        { ...original, matches: [] },
        { ...original, matches: [match, match] },
        { ...original, matches: [{ ...match, [pathKey]: "other.ts" }] },
        { ...original, matches: [{ ...match, [textKey]: index === 0 ? "return 7" : first }] },
        {},
      ]) {
        const calls = chain(mode, "task.ts");
        required(calls[index]).value = mode === "codemode" ? changed : { data: changed };
        assert.equal(check(calls), false, JSON.stringify(changed));
      }
      const missing = chain(mode, "task.ts");
      delete required(missing[index]).value;
      assert.equal(check(missing), false);
    }
  });

  void test(`${mode}: equivalent selections retain execution order, provenance and AST semantics`, () => {
    const calls = chain(mode);
    for (const index of [0, 1, 2]) {
      assert.equal(check(calls.filter((_, i) => i !== index)), false);
      const failed = chain(mode);
      required(failed[index]).error = true;
      assert.equal(check(failed), false);
      const missingEnd = events(calls, mode).filter(
        (event) => event.type !== "tool_execution_end" || event.toolCallId !== String(index),
      );
      assert.equal(validateRoute(enclosing, missingEnd, mode).passed, false);
    }
    assert.equal(check([required(calls[1]), required(calls[0]), required(calls[2])]), false);
    for (const index of [1, 2]) {
      const unrelated = chain(mode);
      required(unrelated[index]).args.path = { id: `RESULT#${ids[3]}` };
      assert.equal(check(unrelated), false);
    }
    for (const change of [{ relation: "inside" }, { language: "python" }, { rule: {} }]) {
      const wrong = chain(mode);
      Object.assign(required(wrong[1]).args, change);
      assert.equal(check(wrong), false);
    }
  });

  void test(`${mode}: AST capture composition accepts directory scope but requires its issued capture`, () => {
    const value = result(mode, 1, first);
    required((data(value).matches as Record<string, unknown>[])[0]).captures = {
      NAME: [{ id: `RESULT#${ids[2]}`, text: "first" }],
    };
    const calls: Call[] = [
      { tool: "outline", args: { path: "task.ts" }, text: "first" },
      {
        tool: "ast_search",
        args: { path: ".", include: "task.ts", pattern: "function $NAME() { return 7; }" },
        value,
      },
      { tool: "replace", args: { path: { id: ids[2] }, text: "renamed" } },
    ];
    assert.ok(validateRoute(capture, events(calls, mode), mode).passed);
    for (const id of [ids[1], ids[3]]) {
      required(calls[2]).args.path = { id };
      assert.equal(validateRoute(capture, events(calls, mode), mode).passed, false);
    }
  });
}

void test("AST composition still validates exact final bytes and untouched files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "issued-matches-"));
  const initial = Object.fromEntries(
    Object.entries(required(enclosing.files)).map(([name, text]) => [name, Buffer.from(text)]),
  );
  try {
    await writeFile(path.join(cwd, "task.ts"), required(enclosing.expected)["task.ts"] as string);
    assert.deepEqual(await validateFiles(cwd, initial, enclosing.expected), []);
    await writeFile(
      path.join(cwd, "task.ts"),
      `${first.replace("7", "8")}\n${second.replace("9", "10")}\n`,
    );
    assert.ok((await validateFiles(cwd, initial, enclosing.expected)).length > 0);
    await writeFile(path.join(cwd, "task.ts"), required(enclosing.expected)["task.ts"] as string);
    await writeFile(path.join(cwd, "other.ts"), "unrelated edit\n");
    assert.ok((await validateFiles(cwd, initial, enclosing.expected)).length > 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
