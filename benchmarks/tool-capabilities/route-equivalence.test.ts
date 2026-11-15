import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  details?: Record<string, unknown>;
  error?: boolean;
}
const uuid = "11111111-aaaa-4aaa-8aaa-111111111111";
const result = `RESULT#${uuid}`;
function events(calls: readonly Call[], mode = "direct"): RunEvent[] {
  const entries: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: `${mode}-${String(index)}`,
      toolName: call.tool,
      args: call.args,
      ...(mode === "codemode" && { parentToolCallId: "script" }),
    },
    {
      type: "tool_execution_end",
      toolCallId: `${mode}-${String(index)}`,
      toolName: call.tool,
      isError: call.error ?? false,
      result: {
        content: [{ type: "text", text: call.text ?? "" }],
        ...(call.value !== undefined && { structuredContent: call.value }),
        ...(call.details && { details: call.details }),
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
  const task = capabilityCases.find((entry) => entry.steps === route) ?? { steps: route };
  return validateRoute(task, events(calls, mode), mode).passed;
}

void test("Codemode skips every discovery step without changing later reuse indices", () => {
  const searchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
  const route: RouteStep[] = [
    { tool: "tool_search", discovers: ["demo_read", "demo_search", "demo_replace"] },
    { tool: "demo_read" },
    { tool: "demo_search", reuse: { from: 1, field: "path" } },
    { tool: "demo_replace", args: { text: "changed" }, reuse: { from: 2, field: "path" } },
  ];
  const calls: Call[] = [
    { tool: "demo_read", args: { path: "memory://demo/note" }, value: { id: result } },
    {
      tool: "demo_search",
      args: { path: { id: result }, query: "alpha" },
      value: { id: searchId },
    },
    { tool: "demo_replace", args: { path: { id: searchId }, text: "changed" } },
  ];
  for (const step of [route[0], { tool: "tool_search" }]) {
    assert.ok(step);
    const task = { steps: [step, ...route.slice(1)] };
    for (const prefix of [
      [],
      events([{ tool: "tool_search", args: {}, details: { loaded: ["demo_read"] } }]),
      events([{ tool: "tool_search", args: {}, error: true }]),
    ]) {
      assert.ok(validateRoute(task, [...prefix, ...events(calls, "codemode")], "codemode").passed);
    }
    assert.ok(!validateRoute(task, events(calls), "direct").passed);
    assert.ok(!validateRoute(task, events(calls.slice(1), "codemode"), "codemode").passed);
    assert.ok(
      !validateRoute(
        task,
        events(
          [
            ...calls.slice(0, 2),
            {
              tool: "demo_replace",
              args: { path: { id: result }, text: "changed" },
            },
          ],
          "codemode",
        ),
        "codemode",
      ).passed,
    );
  }
});

for (const mode of ["direct", "codemode"]) {
  void test(`whole-line edit arguments share effect-based terminal-newline matching in ${mode}`, () => {
    const files = { "task.txt": "first\nmiddle\nlast\n" };
    function edit(
      tool: string,
      required: Record<string, unknown>,
      actual: Record<string, unknown>,
      content = files["task.txt"],
    ) {
      return validateRoute(
        {
          files: { "task.txt": content },
          steps: [{ tool, args: { path: "task.txt", ...required } }],
        },
        events([{ tool, args: { path: "./task.txt", ...actual } }], mode),
        mode,
      ).passed;
    }
    for (const tool of ["insert", "delete", "replace", "copy", "move"]) {
      const selector = tool === "insert" ? "anchor" : "start";
      const extra = tool === "insert" || tool === "replace" ? { text: "NEW\n" } : {};
      const required = { [selector]: /^middle$/u, ...extra };
      assert.ok(edit(tool, required, { [selector]: "middle\n", ...extra }), tool);
      assert.ok(!edit(tool, required, { [selector]: "middle\n\n", ...extra }), tool);
      assert.ok(!edit(tool, required, { [selector]: "other\n", ...extra }), tool);
    }
    assert.ok(
      edit("insert", { anchor: "middle", text: "NEW" }, { anchor: "middle", text: "NEW\n" }),
    );
    assert.ok(
      edit("replace", { start: "middle", text: "NEW" }, { start: "middle", text: "NEW\n" }),
    );
    assert.ok(
      edit("replace", { start: "middle\n", text: "NEW\n" }, { start: "middle", text: "NEW" }),
    );
    for (const text of ["NEW\n\n", "NEW ", "OTHER\n"]) {
      assert.ok(!edit("replace", { start: "middle", text: "NEW" }, { start: "middle", text }));
    }
    assert.ok(!edit("delete", { start: "fir", end: "middle" }, { start: "fir", end: "middle\n" }));
    // Match/partial spans and EOF cannot silently acquire a line break.
    assert.ok(!edit("replace", { start: "midd", text: "NEW" }, { start: "midd", text: "NEW\n" }));
    assert.ok(
      !edit(
        "replace",
        { start: "last", text: "NEW" },
        { start: "last", text: "NEW\n" },
        "first\nlast",
      ),
    );
    assert.ok(!edit("insert", { anchor: "last", text: "NEW\n" }, { anchor: "last", text: "NEW" }));
    assert.ok(
      edit(
        "insert",
        { anchor: "last", before: true, text: "NEW" },
        { anchor: "last", before: true, text: "NEW\n" },
        "first\nlast",
      ),
    );
  });
}
void test("Search :line replacement allows one terminal separator, never :match or fabricated provenance", () => {
  for (const ending of ["\n", "\r\n"]) {
    const line = "SEARCH#ABCD:1:line";
    const search: Call = {
      tool: "search",
      args: { path: "task.txt", query: "beta" },
      text: line + "\nSEARCH#ABCD:1:match",
    };
    const task = {
      files: { "task.txt": `alpha${ending}beta${ending}omega${ending}` },
      steps: [
        { tool: "search" },
        {
          tool: "replace",
          args: { start: /^SEARCH#[A-F0-9]+:1:line$/u, text: "BETA" },
          reuse: { from: 0, field: "start" },
        },
      ],
    };
    const replace: Call = { tool: "replace", args: { start: line, text: "BETA" + ending } };
    assert.ok(validateRoute(task, events([search, replace], "codemode"), "codemode").passed);
    for (const changed of [
      { ...replace, args: { ...replace.args, start: "SEARCH#ABCD:1:match" } },
      { ...replace, args: { ...replace.args, start: "SEARCH#FFFF:1:line" } },
      { ...replace, args: { ...replace.args, text: "BETA" + ending + ending } },
      { ...replace, error: true },
    ])
      assert.ok(!validateRoute(task, events([search, changed], "codemode"), "codemode").passed);
    assert.ok(
      !validateRoute(task, events([{ ...search, error: true }, replace], "codemode"), "codemode")
        .passed,
    );
    const matchTask = {
      ...task,
      steps: [
        { tool: "search" },
        { ...task.steps[1], tool: "replace", args: { start: "SEARCH#ABCD:1:match", text: "BETA" } },
      ],
    };
    assert.ok(
      !validateRoute(
        matchTask,
        events(
          [search, { ...replace, args: { start: "SEARCH#ABCD:1:match", text: "BETA" + ending } }],
          "codemode",
        ),
        "codemode",
      ).passed,
    );
  }
});
const deferredCalls = [
  { tool: "ast_search", args: { path: "task.ts", pattern: "probe($ARG)" }, text: "probe(1)" },
  { tool: "lsp_search", args: { query: "probe" }, text: "task.ts#probe" },
  { tool: "diff", args: { before: "task.ts", after: "task.ts" }, value: "" },
  { tool: "replace", args: { path: "task.txt", start: "OLD", text: "NEW" } },
  { tool: "undo", args: { file: "task.txt", change: "last" } },
  { tool: "read", args: { path: "task.txt" }, text: "keep\nOLD\nlast\n" },
] as const satisfies readonly Call[];
const discoveryCall: Call = {
  tool: "tool_search",
  args: { query: "ast_search lsp_search diff undo" },
  details: { loaded: ["ast_search", "lsp_search", "diff", "undo"] },
};

void test("deferred navigation in Codemode needs only the actual calls, without discovery", () => {
  const route = steps("deferred-navigation-recovery");
  assert.ok(check(route, deferredCalls, "codemode"));
  // Optional top-level discovery may succeed, load nothing, or fail without affecting this route.
  for (const discovery of [
    discoveryCall,
    { ...discoveryCall, details: { loaded: [] } },
    { ...discoveryCall, error: true },
  ]) {
    assert.ok(
      validateRoute(
        { steps: route },
        [...events([discovery]), ...events(deferredCalls, "codemode")],
        "codemode",
      ).passed,
    );
  }
  assert.ok(!check(route, deferredCalls));
  assert.ok(check(route, [discoveryCall, ...deferredCalls]));
});

for (const mode of ["direct", "codemode"]) {
  void test(`deferred navigation still requires every successful operation in ${mode}`, () => {
    const route = steps("deferred-navigation-recovery");
    const prefix = mode === "direct" ? [discoveryCall] : [];
    const checkCalls = (calls: readonly Call[]) => check(route, [...prefix, ...calls], mode);
    assert.ok(checkCalls(deferredCalls));
    for (let index = 0; index < deferredCalls.length; index++) {
      const call = deferredCalls[index];
      assert.ok(call);
      assert.ok(!checkCalls(deferredCalls.filter((_, position) => position !== index)), call.tool);
      assert.ok(
        !checkCalls(
          deferredCalls.map((entry, position) =>
            position === index ? { ...entry, error: true } : entry,
          ),
        ),
        call.tool,
      );
    }
    assert.ok(
      !checkCalls([
        ...deferredCalls.slice(0, 5),
        { ...deferredCalls[5], text: "keep\nNEW\nlast\n" },
      ]),
    );
    if (mode === "codemode") {
      for (const value of [null, "changed", {}]) {
        assert.ok(
          !checkCalls([
            ...deferredCalls.slice(0, 2),
            { ...deferredCalls[2], value },
            ...deferredCalls.slice(3),
          ]),
        );
      }
    }
  });
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

for (const mode of ["direct", "codemode"]) {
  void test(`read-window-insert accepts one terminal newline and requires its Read result in ${mode}`, () => {
    const route = steps("read-window-insert");
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", offset: 2, limit: 1 },
      text: `<uuid>${uuid}</uuid>\nOLD\n`,
      value: { id: result, text: "OLD\n" },
    };
    const source = mode === "codemode" ? read.value : result;
    for (const text of ["BEFORE", "BEFORE\n"]) {
      const insert: Call = { tool: "insert", args: { path: source, before: true, text } };
      for (const path of ["task.txt", ["task.txt"], ["other.txt", "task.txt"]]) {
        assert.ok(check(route, [{ ...read, args: { ...read.args, path } }, insert], mode));
      }
      assert.ok(!check(route, [insert], mode));
      for (const args of [
        { ...read.args, path: ["other.txt"] },
        { ...read.args, path: ["other.txt", "task.txt"], offset: 1 },
        { ...read.args, path: ["other.txt", "task.txt"], limit: 2 },
      ]) {
        assert.ok(!check(route, [{ ...read, args }, insert], mode));
      }
      assert.ok(!check(route, [{ ...read, error: true }, insert], mode));
      for (const path of ["task.txt", "RESULT#22222222-aaaa-4aaa-8aaa-222222222222"]) {
        assert.ok(!check(route, [read, { ...insert, args: { ...insert.args, path } }], mode));
      }
    }
    for (const text of ["BEFORE\n\n", "BEFORE ", "OTHER"]) {
      assert.ok(
        !check(route, [read, { tool: "insert", args: { path: source, before: true, text } }], mode),
      );
    }
    assert.ok(
      !check(
        route,
        [read, { tool: "insert", args: { path: source, before: false, text: "BEFORE\n" } }],
        mode,
      ),
    );
  });
}

void test("debug source Read accepts a path list only with the source and anchors", () => {
  const route = steps("debug-backend-fallback");
  const calls = [
    {
      tool: "debug",
      args: { backend: "vscode", program: "task.py" },
      error: true,
      text: "VS Code",
    },
    {
      tool: "debug",
      args: { backend: "native", adapter: "debugpy", program: "task.py" },
      text: "debug:abcd",
    },
    {
      tool: "read",
      args: { path: ["debug:abcd", "debug:abcd/source"], views: ["anchors"] },
      text: "ABCDEFG|print(value)",
    },
    { tool: "insert", args: { path: "debug:abcd/source", anchor: "ABCDEFG", text: "breakpoint" } },
    { tool: "insert", args: { path: "debug:abcd", text: "start" } },
    { tool: "insert", args: { path: "debug:abcd", text: "evaluate value" }, text: "42" },
    { tool: "delete", args: { path: "debug:abcd" } },
  ] as const satisfies readonly Call[];
  const read = calls[2];
  for (const path of [
    "debug:abcd/source",
    ["debug:abcd/source"],
    ["debug:abcd", "debug:abcd/source"],
    ["debug:abcd/source", "debug:abcd"],
  ]) {
    assert.ok(
      check(route, [
        ...calls.slice(0, 2),
        { ...read, args: { path, views: ["anchors"] } },
        ...calls.slice(3),
      ]),
    );
  }
  for (const args of [
    { path: ["debug:abcd"], views: ["anchors"] },
    { path: ["debug:abcd", "task.py"], views: ["anchors"] },
    { path: [], views: ["anchors"] },
    { path: ["debug:abcd", "debug:abcd/source"] },
    { path: ["debug:abcd", "debug:abcd/source"], views: ["ast"] },
  ]) {
    assert.ok(!check(route, [...calls.slice(0, 2), { ...read, args }, ...calls.slice(3)]));
  }
  assert.ok(!check(route, [...calls.slice(0, 2), ...calls.slice(3)]));
  assert.ok(!check(route, [...calls.slice(0, 2), { ...read, error: true }, ...calls.slice(3)]));
  for (const args of [
    { ...calls[3].args, anchor: "7654321" },
    { ...calls[3].args, path: ["debug:abcd/source", "task.py"] },
  ]) {
    assert.ok(!check(route, [...calls.slice(0, 3), { ...calls[3], args }, ...calls.slice(4)]));
  }
});

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
