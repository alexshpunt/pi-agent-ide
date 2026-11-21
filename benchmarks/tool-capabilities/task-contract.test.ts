import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFiles } from "./sandbox.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  error?: boolean;
  text?: string;
}
function events(calls: Call[], mode = "direct"): RunEvent[] {
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
      result: { content: [{ type: "text", text: call.text ?? "" }] },
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
for (const mode of ["direct", "codemode"]) {
  void test(`independent search roots are a set, but transfer pairs stay ordered (${mode})`, () => {
    for (const tool of ["search", "file_search", "ast_search", "lsp_search"]) {
      const task = { steps: [{ tool, args: { path: ["one", "two", "three"] } }] };
      const check = (roots: string[]) =>
        validateRoute(task, events([{ tool, args: { path: roots } }], mode), mode).passed;
      assert.ok(check(["three", "one", "two"]));
      assert.ok(!check(["one", "two"]));
      assert.ok(!check(["one", "two", "other"]));
      assert.ok(!check(["one", "two", "three", "other"]));
    }
    assert.ok(
      !validateRoute(
        { steps: [{ tool: "copy", args: { path: ["one", "two"], target: ["a", "b"] } }] },
        events([{ tool: "copy", args: { path: ["two", "one"], target: ["a", "b"] } }], mode),
        mode,
      ).passed,
    );
  });
  void test(`exact selection checks the capability, not an author's boundary spelling (${mode})`, async () => {
    const steps: RouteStep[] = [
      { tool: "delete", args: { path: "task.txt" }, exactText: ["start"] },
    ];
    const check = (args: Record<string, unknown>, error = false) =>
      validateRoute({ steps }, events([{ tool: "delete", args, error }], mode), mode).passed;
    for (const start of [
      "tail",
      "tail\n",
      "\ntail\n",
      "abcdefg",
      "abcdefg|literal",
      "END",
      "BEGIN",
    ])
      assert.ok(check({ path: "task.txt", start }));
    for (const start of [
      undefined,
      { id: "RESULT#11111111-aaaa-4aaa-8aaa-111111111111" },
      "regex:tail",
      "SEARCH#ABCD:1:line",
      "123ABCD|tail",
      "end",
    ])
      assert.ok(!check({ path: "task.txt", start }));
    const collision = { files: { "task.txt": "PACKAGE\ntail\n" }, steps };
    assert.ok(
      validateRoute(
        collision,
        events([{ tool: "delete", args: { path: "task.txt", start: "PACKAGE" } }], mode),
        mode,
      ).passed,
    );
    assert.ok(
      !validateRoute(
        collision,
        events(
          [
            { tool: "read", args: { path: "task.txt" }, text: "PACKAGE|tail" },
            { tool: "delete", args: { path: "task.txt", start: "PACKAGE" } },
          ],
          mode,
        ),
        mode,
      ).passed,
    );
    assert.ok(!check({ path: "wrong.txt", start: "tail" }));
    assert.ok(!check({ path: "task.txt", start: "tail" }, true));
    assert.ok(!validateRoute({ steps }, events([], mode), mode).passed);
    assert.ok(
      !validateRoute(
        { steps },
        events([{ tool: "write", args: { path: "task.txt", content: "keep\n" } }], mode),
        mode,
      ).passed,
    );
    assert.ok(
      !validateRoute(
        { steps },
        events(
          [{ tool: "delete", args: { path: "task.txt", start: "tail" } }],
          mode === "direct" ? "codemode" : "direct",
        ),
        mode,
      ).passed,
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "capability-contract-"));
    try {
      const initial = {
        "task.txt": Buffer.from("keep\ntail\n"),
        "sentinel.txt": Buffer.from("KEEP\n"),
      };
      await writeFile(path.join(root, "task.txt"), "keep\n");
      await writeFile(path.join(root, "sentinel.txt"), "KEEP\n");
      assert.deepEqual(await validateFiles(root, initial, { "task.txt": "keep\n" }), []);
      for (const bytes of ["keep", "keep\n\n", "tail\n"]) {
        await writeFile(path.join(root, "task.txt"), bytes);
        assert.ok((await validateFiles(root, initial, { "task.txt": "keep\n" })).length > 0);
      }
      await writeFile(path.join(root, "task.txt"), "keep\n");
      await writeFile(path.join(root, "sentinel.txt"), "CHANGED\n");
      assert.ok((await validateFiles(root, initial, { "task.txt": "keep\n" })).length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  void test(`literal selectors reject references in each required field (${mode})`, () => {
    const reference = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
    const selections = [
      { tool: "replace", fields: ["from", "through"], values: ["START", "END"] },
      { tool: "replace", fields: ["from", "before"], values: ["START", "END"] },
      { tool: "replace", fields: ["after", "through"], values: ["START", "END"] },
      { tool: "copy", fields: ["start", "end"], values: ["COPY_BEGIN", "COPY_END"] },
      { tool: "copy", fields: ["targetStart", "targetEnd"], values: ["SLOT", "SLOT"] },
      { tool: "move", fields: ["targetStart", "targetEnd"], values: ["SLOT", "SLOT"] },
      { tool: "insert", fields: ["anchor"], values: ["α🙂"] },
      { tool: "insert", fields: ["anchor"], values: ["α\r\nβ"] },
      { tool: "delete", fields: ["start"], values: ["Last\nBlock"] },
      { tool: "replace", fields: ["at"], values: ["Last\r\nBlock"] },
    ];
    for (const { tool, fields, values } of selections) {
      const args = {
        path: "task.txt",
        ...Object.fromEntries(fields.map((field, index) => [field, values[index]])),
      };
      const step: RouteStep = { tool, args: { path: "task.txt" }, exactText: fields };
      const check = (input: Record<string, unknown>) =>
        validateRoute({ steps: [step] }, events([{ tool, args: input }], mode), mode).passed;
      assert.ok(check(args));
      for (const field of fields) {
        for (const value of [
          undefined,
          reference,
          { id: reference },
          "SEARCH#ABCD:1:match",
          { id: "SEARCH#ABCD:1:match" },
          "SEARCH#ABCD:1:line",
          "123ABCD|Last",
          "regex:Last",
        ])
          assert.ok(!check({ ...args, [field]: value }));
      }
    }
  });
  void test(`reuse, refusal and genuine dependencies remain mandatory (${mode})`, () => {
    const steps: RouteStep[] = [
      { tool: "read", args: { path: "task.txt" } },
      { tool: "replace", reuse: { from: 0, field: ["path", "at"] } },
      { tool: "delete", args: { path: "sentinel.txt" }, error: true, after: [1] },
    ];
    const calls: [Call, Call, Call] = [
      {
        tool: "read",
        args: { path: "task.txt" },
        text: "<uuid>11111111-aaaa-4aaa-8aaa-111111111111</uuid>",
      },
      {
        tool: "replace",
        args: { path: "RESULT#11111111-aaaa-4aaa-8aaa-111111111111", text: "NEW" },
      },
      { tool: "delete", args: { path: "sentinel.txt" }, error: true },
    ];
    const check = (input: Call[]) => validateRoute({ steps }, events(input, mode), mode).passed;
    assert.ok(check(calls));
    assert.ok(
      !check([
        calls[0],
        { ...calls[1], args: { path: "task.txt", at: "OLD", text: "NEW" } },
        calls[2],
      ]),
    );
    assert.ok(!check([calls[0], calls[1], { ...calls[2], error: false }]));
    assert.ok(!check([calls[0], calls[2], calls[1]]));
    assert.ok(!check([calls[0], calls[1]]));
    const independent: RouteStep[] = [
      { tool: "read", args: { path: "a" } },
      { tool: "read", args: { path: "b" } },
    ];
    assert.ok(
      validateRoute(
        { steps: independent },
        events(
          [
            { tool: "read", args: { path: "b" } },
            { tool: "read", args: { path: "a" } },
          ],
          mode,
        ),
        mode,
      ).passed,
    );
  });
}
