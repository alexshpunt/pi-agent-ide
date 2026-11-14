import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
}
const uuid = "11111111-aaaa-4aaa-8aaa-111111111111";
const result = `RESULT#${uuid}`;
function events(calls: readonly Call[], mode = "direct"): RunEvent[] {
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
        ...(call.value !== undefined && { structuredContent: call.value }),
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
function steps(id: string): RouteStep[] {
  const task = capabilityCases.find((entry) => entry.id === id);
  assert.ok(task);
  return task.steps;
}
function check(route: RouteStep[], calls: readonly Call[], mode = "direct"): boolean {
  return validateRoute({ steps: route }, events(calls, mode), mode).passed;
}

for (const [id, tool, index] of [
  ["standalone-resource-host", "demo_read", 1],
  ["streamed-replace", "read", 1],
] as const) {
  void test(`${id} accepts only the default first offset when omitted`, () => {
    const step = steps(id)[index];
    assert.ok(step);
    const args = { ...step.args };
    delete args.offset;
    const call = { tool, args, text: step.contains };
    assert.ok(check([step], [call]));
    assert.ok(!check([step], [{ ...call, args: { ...args, offset: 2 } }]));
    assert.ok(!check([step], [{ ...call, args: { ...args, limit: 99 } }]));
  });
}

for (const mode of ["direct", "codemode"]) {
  void test(`insert-before derives the file from its issued match anchor in ${mode}`, () => {
    const route = steps("insert-before")
      .slice(5)
      .map((step) =>
        step.reuse
          ? {
              ...step,
              reuse: {
                from: step === steps("insert-before")[6] ? 0 : 2,
                field: "anchor",
                kind: "anchor",
              },
            }
          : step,
      );
    const first = mode === "direct" ? "SEARCH#ABCD:1:match" : result;
    const second =
      mode === "direct" ? "SEARCH#DCBA:1:match" : "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
    const calls = [
      {
        tool: "search",
        args: { path: "search.txt", query: "MATCH" },
        text: first,
        value: { matches: [{ id: first }] },
      },
      { tool: "insert", args: { anchor: first, text: "[", before: true } },
      {
        tool: "search",
        args: { path: "search.txt", query: "MATCH" },
        text: second,
        value: { matches: [{ id: second }] },
      },
      { tool: "insert", args: { anchor: second, text: "]" } },
    ] as const satisfies readonly Call[];
    assert.ok(check(route, calls, mode));
    for (const args of [
      { anchor: "SEARCH#FFFF:1:match", text: "[", before: true },
      { ...calls[1].args, path: "wrong.txt" },
    ]) {
      assert.ok(!check(route, [calls[0], { tool: "insert", args }, ...calls.slice(2)], mode));
    }
    assert.ok(
      !check(
        route,
        [{ ...calls[0], args: { path: "wrong.txt", query: "MATCH" } }, ...calls.slice(1)],
        mode,
      ),
    );
  });
}

void test("debug source accepts the earlier Read value, not an unrelated or failed result", () => {
  const breakpoint = steps("debug-backend-fallback")[3];
  assert.ok(breakpoint);
  const route: RouteStep[] = [
    { tool: "read" },
    { ...breakpoint, reuse: { from: 0, field: "anchor", kind: "anchor" } },
  ];
  const read: Call = {
    tool: "read",
    args: { path: "debug:abcd/source" },
    text: `<uuid>${uuid}</uuid>\nABCDEFG|print(value)`,
    value: { id: result, text: "ABCDEFG|print(value)" },
  };
  const edit: Call = {
    tool: "insert",
    args: { path: read.value, anchor: "ABCDEFG", text: "breakpoint" },
  };
  assert.ok(check(route, [read, edit], "codemode"));
  assert.ok(
    !check(
      route,
      [
        read,
        {
          ...edit,
          args: { ...edit.args, path: { id: "RESULT#22222222-aaaa-4aaa-8aaa-222222222222" } },
        },
      ],
      "codemode",
    ),
  );
  assert.ok(!check(route, [{ ...read, error: true }, edit], "codemode"));
});

void test("shifted repeated-line route accepts the issued alpha anchor and line separation", () => {
  const calls = [
    {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "ABCDEFG|alpha\nHJKMNPQ|other\nRSTVWXY|}",
    },
    { tool: "insert", args: { path: "task.txt", anchor: "ABCDEFG", before: true, text: "top" } },
    { tool: "delete", args: { path: "task.txt", start: "RSTVWXY" } },
  ] as const satisfies readonly Call[];
  const route = steps("repeated-line-anchor-after-shift");
  assert.ok(check(route, calls));
  assert.ok(
    !check(route, [
      calls[0],
      { ...calls[1], args: { ...calls[1].args, text: "top\n\n" } },
      calls[2],
    ]),
  );
  for (const anchor of ["HJKMNPQ", "7654321"]) {
    assert.ok(
      !check(route, [calls[0], { ...calls[1], args: { ...calls[1].args, anchor } }, calls[2]]),
    );
  }
  assert.ok(
    !check(route, [calls[0], { ...calls[1], args: { ...calls[1].args, before: false } }, calls[2]]),
  );
});

for (const ending of ["lf", "crlf"]) {
  void test(`exact-eof-${ending} accepts a block selector including its terminal separator`, () => {
    const eol = ending === "lf" ? "\n" : "\r\n";
    const calls = [
      { tool: "replace", args: { path: "last.txt", start: "Last", text: "Final" } },
      { tool: "delete", args: { path: "block.txt", start: `Last${eol}Block${eol}` } },
      { tool: "replace", args: { path: "empty.txt", start: `Last${eol}Block${eol}`, text: "" } },
      { tool: "read", args: { path: "line.txt", views: ["anchors"] }, text: "ABCDEFG|Last" },
      { tool: "delete", args: { path: "line.txt", start: "ABCDEFG" } },
    ] as const satisfies readonly Call[];
    assert.ok(check(steps(`exact-eof-${ending}`), calls, "codemode"));
    assert.ok(
      !check(
        steps(`exact-eof-${ending}`),
        [
          calls[0],
          { ...calls[1], args: { ...calls[1].args, start: `Last${eol}Block${eol}${eol}` } },
          ...calls.slice(2),
        ],
        "codemode",
      ),
    );
    assert.ok(
      !check(
        steps(`exact-eof-${ending}`),
        [
          calls[0],
          { ...calls[1], args: { path: "block.txt", start: `First${eol}Last${eol}Block${eol}` } },
          ...calls.slice(2),
        ],
        "codemode",
      ),
    );
  });
}

void test("token edit accepts an issued first match in start but not an outer result or other match", () => {
  const route = steps("token-search-edit-guard");
  const calls = [
    {
      tool: "search",
      args: { path: "split.txt", query: "alpha beta" },
      text: `<uuid>${uuid}</uuid>`,
    },
    { tool: "replace", args: { path: result, text: "BAD" }, error: true, text: "alpha beta" },
    {
      tool: "search",
      args: { path: "split.txt", query: "alpha OR beta" },
      text: "SEARCH#ABCD:1:match\nSEARCH#ABCD:2:match",
    },
    { tool: "replace", args: { start: "SEARCH#ABCD:1:match", text: "GREEN" } },
    {
      tool: "search",
      args: { path: "literal.txt", query: '"alpha beta"' },
      text: `<uuid>${uuid}</uuid>`,
    },
    { tool: "replace", args: { path: result, text: "LITERAL" } },
  ] as const satisfies readonly Call[];
  assert.ok(check(route, calls));
  for (const start of [result, "SEARCH#ABCD:2:match", "SEARCH#FFFF:1:match"]) {
    assert.ok(
      !check(route, [
        ...calls.slice(0, 3),
        { ...calls[3], args: { start, text: "GREEN" } },
        ...calls.slice(4),
      ]),
    );
  }
});

void test("multiline replacement must reuse the first search, in path or start", () => {
  const route = steps("search-multiline-between");
  const calls = [
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:old one\\nold two", multiline: true },
      text: "SEARCH#ABCD:1:line",
    },
    { tool: "search", args: { path: "task.txt", query: "keep" }, text: "SEARCH#DCBA:1:line" },
    { tool: "replace", args: { path: "task.txt", start: "SEARCH#ABCD:1:line", text: "NEW\n" } },
  ] as const satisfies readonly Call[];
  assert.ok(check(route, calls));
  for (const start of ["SEARCH#DCBA:1:line", "SEARCH#FFFF:1:line", "old one\nold two"]) {
    assert.ok(
      !check(route, [...calls.slice(0, 2), { ...calls[2], args: { ...calls[2].args, start } }]),
    );
  }
});

void test("issued-result-edit requires a successful bounded selector replacement", () => {
  const calls = [
    { tool: "search", args: { path: "task.txt", query: "OLD" }, text: `<uuid>${uuid}</uuid>` },
    { tool: "replace", args: { path: result, text: "NEW" } },
    {
      tool: "search",
      args: { path: "task.txt", query: "NEW" },
      text: "<uuid>22222222-aaaa-4aaa-8aaa-222222222222</uuid>",
    },
    {
      tool: "replace",
      args: { path: "RESULT#22222222-aaaa-4aaa-8aaa-222222222222", start: "NEW", text: "FINAL" },
    },
    { tool: "read", args: { path: "task.txt" }, text: "keep\nFINAL\nlast\n" },
  ] as const satisfies readonly Call[];
  const route = steps("issued-result-edit");
  assert.ok(check(route, calls));
  assert.ok(!check(route, [...calls.slice(0, 3), { ...calls[3], error: true }, calls[4]]));
  assert.ok(
    !check(route, [
      ...calls.slice(0, 3),
      { ...calls[3], args: { ...calls[3].args, path: result } },
      calls[4],
    ]),
  );
});
