import { strict as assert } from "node:assert";
import test from "node:test";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

const id = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
const matchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
const ref = "SEARCH#ABCD:1:match";
interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
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
const files = { "task.txt": "KEEP\r\n段🙂\r\n尾界", "target.txt": "left SLOT right\n" };
const found: Call = {
  tool: "search",
  args: { path: "task.txt", query: "regex:段🙂\\r\\n尾界", multiline: true },
  text: `${ref} SEARCH#ABCD:1:line`,
  value: {
    id,
    data: {
      complete: true,
      matches: [
        {
          target: matchId,
          source: "task.txt",
          range: { startLine: 2, startColumn: 0, endLine: 3, endColumn: 2 },
          matchedText: "段🙂\r\n尾界",
          lineText: "段🙂\r\n尾界",
          references: { match: ref, line: "SEARCH#ABCD:1:line" },
        },
      ],
    },
  },
};
const scriptFound: Call = {
  ...found,
  value: {
    id,
    complete: true,
    matches: [
      {
        id: matchId,
        path: "task.txt",
        line: 2,
        text: "段🙂\r\n尾界",
        lineText: "段🙂\r\n尾界",
      },
    ],
  },
};
function passes(steps: RouteStep[], calls: Call[], mode: string) {
  return validateRoute({ files, steps }, events(calls, mode), mode).passed;
}
for (const mode of ["direct", "codemode"]) {
  void test(`argument variants cannot override a base constraint in ${mode}`, () => {
    assert.ok(
      !passes(
        [{ tool: "read", args: { path: "task.txt" }, argsAny: [{ path: "wrong.txt" }] }],
        [{ tool: "read", args: { path: "wrong.txt" } }],
        mode,
      ),
    );
  });
  for (const tool of ["replace", "insert", "delete", "copy", "move"]) {
    void test(`${tool} accepts displayed anchors and inferred sources in ${mode}`, () => {
      const field = tool === "insert" ? "anchor" : "start";
      const read: Call = {
        tool: "read",
        args: { path: "task.txt", views: ["anchors"] },
        text: "123ABCD|KEEP\r\n",
      };
      const route: RouteStep[] = [
        { tool: "read" },
        {
          tool,
          args: { path: "task.txt", [field]: /^[0-9A-HJKMNP-TV-Z]{7}$/u },
          reuse: { from: 0, field, kind: "anchor" },
        },
      ];
      for (const selection of ["123ABCD", "123ABCD|KEEP", "123ABCD|KEEP\n", "123ABCD|KEEP\r\n"]) {
        assert.ok(passes(route, [read, { tool, args: { [field]: selection } }], mode));
        assert.ok(
          passes(route, [read, { tool, args: { path: "task.txt", [field]: selection } }], mode),
        );
      }
      for (const selection of ["123ABCD|OTHER", "123ABCD|KEEP\n\n", "765ABCD|KEEP"])
        assert.ok(!passes(route, [read, { tool, args: { [field]: selection } }], mode));
      assert.ok(
        !passes(
          route,
          [read, { tool, args: { path: "wrong.txt", [field]: "123ABCD|KEEP" } }],
          mode,
        ),
      );
    });
    void test(`${tool} accepts an equal multiline issued selection across argument forms in ${mode}`, () => {
      const field = tool === "insert" ? "anchor" : "start";
      const extra = ["copy", "move"].includes(tool)
        ? { target: "target.txt", targetStart: "SLOT", targetEnd: "SLOT" }
        : ["insert", "replace"].includes(tool)
          ? { text: "NEW" }
          : {};
      const required = { path: "task.txt", [field]: "段🙂\r\n尾界", ...extra };
      const steps: RouteStep[] = [{ tool: "search" }, { tool, args: required }];
      for (const selection of [ref, { id: matchId }, { id }]) {
        for (const args of [
          { path: "task.txt", [field]: selection, ...extra },
          { [field]: selection, ...extra },
          { path: selection, ...extra },
        ]) {
          const edit = { tool, args };
          assert.ok(passes(steps, [found, edit], mode), JSON.stringify(args));
          assert.ok(passes(steps, [scriptFound, edit], mode), JSON.stringify(args));
          assert.ok(!passes(steps, [{ ...found, error: true }, edit], mode));
          assert.ok(!passes(steps, [edit], mode));
        }
      }
      const edit: Call = { tool, args: { path: "task.txt", [field]: ref, ...extra } };
      for (const args of [
        { ...edit.args, path: "wrong.txt" },
        { ...edit.args, [field]: "SEARCH#FFFF:1:match" },
      ])
        assert.ok(!passes(steps, [found, { ...edit, args }], mode));
      const variantSteps: RouteStep[] = [
        { tool: "search" },
        { tool, args: { path: "task.txt", ...extra }, argsAny: [{ [field]: "段🙂\r\n尾界" }] },
      ];
      assert.ok(passes(variantSteps, [found, edit], mode));
      const wrongSpan = {
        ...found,
        value: {
          id,
          data: {
            complete: true,
            matches: [
              {
                target: matchId,
                source: "task.txt",
                range: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 3 },
                matchedText: "段🙂",
                lineText: "段🙂",
                references: { match: ref },
              },
            ],
          },
        },
      };
      assert.ok(!passes(steps, [wrongSpan, edit], mode));
      const throughBreak = "KEEP\r\n段🙂\r\n";
      const endingAtNextLine: Call = {
        ...found,
        value: {
          id,
          data: {
            complete: true,
            matches: [
              {
                target: matchId,
                source: "task.txt",
                range: { startLine: 1, startColumn: 0, endLine: 3, endColumn: 0 },
                matchedText: throughBreak,
                lineText: "KEEP\r\n段🙂",
                references: { match: ref },
              },
            ],
          },
        },
      };
      const newlineRoute: RouteStep[] = [
        { tool: "search" },
        { tool, args: { path: "task.txt", [field]: throughBreak, ...extra } },
      ];
      assert.ok(passes(newlineRoute, [endingAtNextLine, edit], mode));
      const scriptEndingAtNextLine: Call = {
        ...found,
        value: {
          id,
          complete: true,
          matches: [
            {
              id: matchId,
              path: "task.txt",
              line: 1,
              text: throughBreak,
              lineText: "KEEP\r\n段🙂",
            },
          ],
        },
      };
      assert.ok(passes(newlineRoute, [scriptEndingAtNextLine, edit], mode));
    });
    void test(`${tool} preserves required whole-result reuse when selectors move in ${mode}`, () => {
      const field = tool === "insert" ? "anchor" : "start";
      const route: RouteStep[] = [
        { tool: "search" },
        {
          tool,
          args: { path: /^RESULT#/u },
          reuse: { from: 0, field: "path", kind: "whole-result" },
        },
      ];
      for (const args of [
        { path: "task.txt", [field]: { id: matchId } },
        { [field]: ref },
        { path: { id: matchId } },
        { path: ref },
      ])
        assert.ok(passes(route, [found, { tool, args }], mode), JSON.stringify(args));
      assert.ok(
        !passes(
          route,
          [found, { tool, args: { path: "task.txt", [field]: "段🙂\r\n尾界" } }],
          mode,
        ),
      );
      const partial = {
        ...found,
        value: {
          id,
          data: {
            complete: true,
            matches: [
              { target: matchId, source: "task.txt", references: { match: ref } },
              { target: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333", source: "task.txt" },
            ],
          },
        },
      };
      assert.ok(!passes(route, [partial, { tool, args: { [field]: ref } }], mode));
    });
  }
  for (const tool of ["undo", "stage", "unstage"]) {
    void test(`${tool} infers only the file identified by its issued CHANGE in ${mode}`, () => {
      const read: Call = {
        tool: "read",
        args: { path: "task.txt", views: ["changes"] },
        text: "CHANGE#ABCD",
      };
      const route: RouteStep[] = [
        { tool: "read" },
        { tool, args: { file: "task.txt" }, reuse: { from: 0, field: "change", kind: "change" } },
      ];
      const edit: Call = { tool, args: { change: "CHANGE#ABCD" } };
      assert.ok(passes(route, [read, edit], mode));
      for (const args of [{ change: "CHANGE#FFFF" }, { file: "wrong.txt", change: "CHANGE#ABCD" }])
        assert.ok(!passes(route, [read, { ...edit, args }], mode));
      assert.ok(!passes(route, [{ ...read, error: true }, edit], mode));
      assert.ok(
        !passes(
          route,
          [{ ...read, args: { path: ["task.txt", "other.txt"], views: ["changes"] } }, edit],
          mode,
        ),
      );
    });
  }
  for (const tool of ["copy", "move"]) {
    void test(`${tool} resolves destination selectors and infers their file in ${mode}`, () => {
      const destination: Call = {
        tool: "search",
        args: { path: "target.txt", query: "SLOT" },
        text: "SEARCH#EF01:1:match",
        value: {
          id: matchId,
          data: {
            complete: true,
            matches: [
              {
                source: "target.txt",
                target: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
                range: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 9 },
                matchedText: "SLOT",
                lineText: "left SLOT right",
                references: { match: "SEARCH#EF01:1:match" },
              },
            ],
          },
        },
      };
      const route: RouteStep[] = [
        { tool: "search" },
        {
          tool,
          args: {
            path: "task.txt",
            start: "尾界",
            target: "target.txt",
            targetStart: "SLOT",
            targetEnd: "SLOT",
          },
          reuse: { from: 0, field: "targetStart", kind: "anchor" },
        },
      ];
      const edit: Call = {
        tool,
        args: {
          path: "task.txt",
          start: "尾界",
          targetStart: "SEARCH#EF01:1:match",
          targetEnd: "SEARCH#EF01:1:match",
        },
      };
      assert.ok(passes(route, [destination, edit], mode));
      assert.ok(
        !passes(
          route,
          [destination, { ...edit, args: { ...edit.args, target: "wrong.txt" } }],
          mode,
        ),
      );
    });
  }
}
