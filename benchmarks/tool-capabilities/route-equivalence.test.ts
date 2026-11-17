import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFiles } from "./sandbox.ts";
import { capabilityCases } from "./cases.ts";
import { checkCoverage, validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

for (const mode of ["direct", "codemode"]) {
  void test(`whole-line transfers accept issued source and destination selectors (${mode})`, () => {
    const task = capabilityCases.find((entry) => entry.id === "exact-range-copy");
    assert.ok(task);
    const route = task.steps.slice(3).map((step) => ({ ...step, sameAssistantWith: undefined }));
    const calls: Call[] = [
      { tool: "read", args: { path: "whole.txt", views: ["anchors"] }, text: "T286A4V|段🙂" },
      { tool: "read", args: { path: "inserted.txt", views: ["anchors"] }, text: "6QG98NT|ANCHOR" },
      {
        tool: "copy",
        args: {
          path: "whole.txt",
          start: "T286A4V",
          target: "inline.txt",
          targetStart: "SLOT",
          targetEnd: "SLOT",
        },
      },
      {
        tool: "copy",
        args: {
          path: "whole.txt",
          start: "T286A4V",
          target: "inserted.txt",
          targetStart: "6QG98NT",
        },
      },
    ];
    assert.ok(validateRoute({ ...task, steps: route }, events(calls, mode), mode).passed);
    assert.ok(
      !validateRoute({ ...task, steps: route }, events(calls.slice(0, -1), mode), mode).passed,
    );
    const move = steps("exact-range-move")[5];
    assert.ok(move);
    assert.ok(
      check(
        [{ ...move, sameAssistantWith: undefined }],
        [
          {
            tool: "move",
            args: {
              path: "eof.txt",
              start: result,
              target: "inline.txt",
              targetStart: "SLOT",
              targetEnd: "SLOT",
            },
          },
        ],
        mode,
      ),
    );
  });
  void test(`destination recovery leaves source boundary representation free (${mode})`, () => {
    const calls: Call[] = [
      {
        tool: "read",
        args: { path: "task.txt", views: ["anchors"] },
        text: "S5BM5NA|alpha\nFDCR4F0|beta",
      },
      {
        tool: "copy",
        args: { path: "task.txt", start: "S5BM5NA|alpha", end: "FDCR4F0|beta", targetStart: "});" },
        error: true,
        text: "ambiguous",
      },
      {
        tool: "read",
        args: { path: "task.txt", views: ["anchors"] },
        text: "S5BM5NA|alpha\nFDCR4F0|beta\n7EQS4MN|INSERT_HERE",
      },
      {
        tool: "copy",
        args: {
          path: "task.txt",
          start: "S5BM5NA|alpha",
          end: "FDCR4F0|beta",
          targetStart: "7EQS4MN|INSERT_HERE",
        },
      },
    ];
    const route = steps("copy-destination-recovery");
    assert.ok(check(route, calls, mode));
    assert.ok(
      !check(
        route,
        calls.map((call) => (call.error ? { ...call, error: false } : call)),
        mode,
      ),
    );
    assert.ok(
      !check(
        route,
        [
          ...calls.slice(0, -1),
          {
            ...calls[3],
            tool: "copy",
            args: { path: "task.txt", start: "alpha", end: "beta", targetStart: "INSERT_HERE" },
          },
        ],
        mode,
      ),
    );
  });
}

for (const mode of ["direct", "codemode"]) {
  void test(`path-list searches check roots and results independently of query spelling (${mode})`, () => {
    const calls: [Call, Call, Call] = [
      {
        tool: "search",
        args: { path: ["src/api", "src/code-view"], query: "formatSymbolSelector" },
        text: "src/api/use.ts",
      },
      {
        tool: "file_search",
        args: { path: ["src/api", "src/code-view"], pattern: "*.ts" },
        text: "src/code-view/format.ts",
      },
      {
        tool: "ast_search",
        args: {
          path: ["src/api", "src/code-view"],
          pattern: "formatSymbolSelector($$$ARGS)",
          language: "typescript",
        },
        text: "PASS-MARKER",
      },
    ];
    const route = steps("search-path-list");
    assert.ok(check(route, calls, mode));
    for (const index of [0, 1, 2]) {
      assert.ok(
        !check(
          route,
          calls.filter((_, at) => at !== index),
          mode,
        ),
      );
      assert.ok(
        !check(
          route,
          calls.map((call, at) =>
            at === index
              ? { ...call, args: { ...call.args, path: ["src/api", "src/other"] } }
              : call,
          ),
          mode,
        ),
      );
    }
    assert.ok(!check(route, [...calls.slice(0, 2), { ...calls[2], text: "OTHER-MARKER" }], mode));
  });
}
void test("raw Read defaults to byte zero without relaxing line paging or byte limits", () => {
  const calls: [Call, Call, Call] = [
    { tool: "read", args: { path: "." } },
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, text: "OLD" },
    { tool: "read", args: { path: "raw:/workspace/fixture/task.txt", limit: 4 }, text: "keep" },
  ];
  const route = steps("read-text");
  assert.ok(check(route, calls));
  for (const args of [
    { path: "raw:task.txt", offset: 1, limit: 4 },
    { path: "raw:task.txt", limit: 5 },
    { path: "task.txt", limit: 4 },
    { path: "raw:other.txt", limit: 4 },
  ])
    assert.ok(!check(route, [...calls.slice(0, 2), { ...calls[2], args }]));
  assert.ok(
    !check(route, [calls[0], { ...calls[1], args: { path: "task.txt", limit: 1 } }, calls[2]]),
  );
});

void test("native value batch accepts the complete gamma line and retains its batch and reuse guards", () => {
  const calls: [Call, Call, Call, Call] = [
    {
      tool: "search",
      args: { path: "task.txt", query: "beta" },
      value: { matches: [{ id: result }] },
    },
    { tool: "insert", args: { path: "task.txt", anchor: "alpha", before: true, text: "added" } },
    { tool: "replace", args: { path: { id: result }, text: "BETA" } },
    { tool: "delete", args: { path: "task.txt", start: "gamma\n" } },
  ];
  function batch(input: Call[], size = 3, concurrent = true): boolean {
    const serial = events(input, "codemode");
    const edits = serial.slice(3, -1);
    const entries = concurrent
      ? [
          ...serial.slice(0, 3),
          ...edits.filter((entry) => entry.type === "tool_execution_start"),
          ...edits.filter((entry) => entry.type === "tool_execution_end"),
          ...serial.slice(-1),
        ]
      : serial;
    const parentEnd = entries.at(-1);
    assert.ok(parentEnd);
    parentEnd.result = {
      details: {
        editorBatches: [
          {
            applied: true,
            calls: Array.from({ length: size }, (_, index) => ({
              id: `codemode-${String(index + 1)}`,
            })),
          },
        ],
      },
    };
    return validateRoute(
      {
        steps: steps("codemode-search-value-batch"),
        files: { "task.txt": "alpha\nbeta\ngamma\nomega\n" },
      },
      entries,
      "codemode",
    ).passed;
  }
  assert.ok(batch(calls));
  assert.ok(!batch(calls, 3, false));
  assert.ok(
    batch([...calls.slice(0, 3), { ...calls[3], args: { path: "task.txt", start: "gamma" } }]),
  );
  for (const start of [undefined, "SEARCH#ABCD:1:line", "regex:gamma"])
    assert.ok(!batch([...calls.slice(0, 3), { ...calls[3], args: { path: "task.txt", start } }]));
  assert.ok(!batch(calls, 2));
  assert.ok(
    !batch([
      ...calls.slice(0, 2),
      { ...calls[2], args: { path: "task.txt", start: "beta", text: "BETA" } },
      calls[3],
    ]),
  );
  assert.ok(!batch([...calls.slice(0, 3), { ...calls[3], error: true }]));
});

void test("explicit-path scope retry is independent of the failed result-bound edit", () => {
  const calls: [Call, Call, Call] = [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, text: `<uuid>${uuid}</uuid>` },
    { tool: "replace", args: { path: result, start: "last", text: "BAD" }, error: true },
    { tool: "replace", args: { path: "task.txt", start: "last", text: "fixed" } },
  ];
  const task = capabilityCases.find((entry) => entry.id === "result-selector-exact-retry");
  assert.ok(task);
  const entries = events(calls);
  assert.ok(
    validateRoute(
      task,
      [...entries.slice(0, 3), ...entries.slice(4), ...entries.slice(3, 4)],
      "direct",
    ).passed,
  );
  assert.ok(check(task.steps, [calls[0], calls[2], calls[1]]));
  assert.ok(!check(task.steps, [calls[0], calls[2]]));
  assert.ok(!check(task.steps, [calls[0], { ...calls[1], error: false }, calls[2]]));
  assert.ok(
    !check(task.steps, [
      calls[0],
      calls[1],
      { ...calls[2], args: { path: "other.txt", start: "last", text: "fixed" } },
    ]),
  );
  assert.ok(
    !check(task.steps, [
      calls[0],
      calls[1],
      // The real tool refuses this selection: last is outside the line-2 window.
      { ...calls[2], args: { path: result, start: "last", text: "fixed" }, error: true },
    ]),
  );
});

void test("shell roundtrip accepts one multi-source Read without losing any source provenance", () => {
  const writeId = "22222222-aaaa-4aaa-8aaa-222222222222";
  const insertId = "33333333-aaaa-4aaa-8aaa-333333333333";
  const sources = [{ id: writeId }, { id: insertId }, "shell:input-check"];
  const calls: [Call, Call, Call, Call, Call, Call, Call] = [
    { tool: "bash", args: { background: true }, text: "shell:input-check" },
    {
      tool: "write",
      args: { path: "shell:input-check", content: "hello" },
      text: `<uuid>${writeId}</uuid>`,
    },
    {
      tool: "insert",
      args: { path: "shell:input-check", text: "Enter" },
      text: `<uuid>${insertId}</uuid>`,
    },
    {
      tool: "read",
      args: { path: sources },
      text: `<uuid>${uuid}</uuid>\nhello`,
      value: sources.map((_, index) => ({
        id: `RESULT#44444444-aaaa-4aaa-8aaa-44444444444${index}`,
        text: "hello",
      })),
    },
    {
      tool: "replace",
      args: { path: result, start: "hello", text: "BAD" },
      error: true,
      text: steps("shell-roundtrip").find((step) => step.tool === "replace")?.contains,
    },
    { tool: "search", args: { path: "shell:input-check", query: "hello" }, text: "hello" },
    { tool: "delete", args: { path: "shell:input-check" } },
  ];
  const route = steps("shell-roundtrip");
  assert.ok(check(route, calls));
  assert.ok(
    check(route, [
      ...calls.slice(0, 3),
      ...sources.map((source) => ({ ...calls[3], args: { path: source }, value: undefined })),
      ...calls.slice(4),
    ]),
  );
  for (let missing = 0; missing < sources.length; missing++) {
    assert.ok(
      !check(route, [
        ...calls.slice(0, 3),
        { ...calls[3], args: { path: sources.filter((_, index) => index !== missing) } },
        ...calls.slice(4),
      ]),
    );
  }
  for (const path of [
    [sources[0], sources[0], sources[2]],
    [sources[0], { id: uuid }, sources[2]],
    [sources[0], sources[1], "shell:other"],
  ]) {
    assert.ok(
      !check(route, [...calls.slice(0, 3), { ...calls[3], args: { path } }, ...calls.slice(4)]),
    );
  }
  assert.ok(!check(route, [...calls.slice(0, 3), { ...calls[3], error: true }, ...calls.slice(4)]));
  assert.ok(!check(route, [...calls.slice(0, 2), calls[3], calls[2], ...calls.slice(4)]));
});

void test("a multi-source Read cannot replace repeated calls or an ordered Read dependency", () => {
  const route: [RouteStep, RouteStep] = [
    { tool: "read", args: { path: "a.txt", offset: 2, limit: 1, views: ["anchors"] } },
    { tool: "read", args: { path: "b.txt", offset: 2, limit: 1, views: ["anchors"] } },
  ];
  const calls: [Call] = [
    { tool: "read", args: { path: ["a.txt", "b.txt"], offset: 2, limit: 1, views: ["anchors"] } },
  ];
  assert.ok(check(route, calls));
  assert.ok(!check([route[0], route[0]], calls));
  assert.ok(!check([route[0], { ...route[1], after: [0] }], calls));
  for (const args of [
    { ...calls[0].args, offset: 1 },
    { ...calls[0].args, views: [] },
    { ...calls[0].args, limit: 2 },
  ])
    assert.ok(!check(route, [{ ...calls[0], args }]));
});

void test("native Search insertion checks reuse and its final match-boundary bytes", async () => {
  const calls: [Call, Call] = [
    {
      tool: "search",
      args: { path: "task.txt", query: "OLD" },
      value: { matches: [{ id: result }] },
    },
    { tool: "insert", args: { path: { id: result }, text: "\nNEW" } },
  ];
  const route = steps("search-anchor-insert");
  assert.ok(check(route, calls, "codemode"));
  assert.ok(await outputPasses("search-anchor-insert", "keep\nOLD\nNEW\nlast\n"));
  for (const text of ["NEW", "\n\nNEW", "\nOTHER"]) {
    assert.ok(
      check(route, [calls[0], { ...calls[1], args: { ...calls[1].args, text } }], "codemode"),
    );
    assert.equal(await outputPasses("search-anchor-insert", `keep\nOLD${text}\nlast\n`), false);
  }
  assert.ok(
    !check(
      route,
      [calls[0], { ...calls[1], args: { path: "task.txt", anchor: "OLD", text: "\nNEW" } }],
      "codemode",
    ),
  );
  const direct: [Call, Call] = [
    { tool: "search", args: { path: "task.txt", query: "OLD" }, text: "SEARCH#ABCD:1:line" },
    { tool: "insert", args: { path: "SEARCH#ABCD:1:line", text: "NEW" } },
  ];
  assert.ok(check(route, direct));
});
async function outputPasses(id: string, text: string): Promise<boolean> {
  const task = capabilityCases.find((entry) => entry.id === id);
  assert.ok(task);
  assert.deepEqual(Object.keys(task.expected ?? {}), ["task.txt"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-insert-outcome-"));
  try {
    await writeFile(path.join(root, "task.txt"), text);
    const initial = Object.fromEntries(
      Object.entries(task.files ?? {}).map(([name, value]) => [name, Buffer.from(value)]),
    );
    return (await validateFiles(root, initial, task.expected)).length === 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
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

for (const id of [
  "shell-roundtrip",
  "diagnostics-report",
  "directory-transfers",
  "binary-copy-move",
]) {
  const task = capabilityCases.find((entry) => entry.id === id);
  assert.ok(task);
  const refusal = task.steps.find((step) => step.error);
  assert.ok(refusal && refusal.reuse && !Array.isArray(refusal.reuse));
  const issuer = task.steps[refusal.reuse.from];
  assert.ok(issuer);
  const route: RouteStep[] = [
    { tool: issuer.tool },
    { ...refusal, reuse: { ...refusal.reuse, from: 0 } },
  ];
  for (const mode of task.modes.filter((mode) => !refusal.modes || refusal.modes.includes(mode))) {
    void test(`${id} accepts early authority refusals without incidental arguments (${mode})`, () => {
      const issued: Call = {
        tool: issuer.tool,
        args: {},
        text: `<uuid>${uuid}</uuid>`,
        value: { id: result },
      };
      for (const extras of refusal.tool === "replace"
        ? [{ text: "BAD" }, { start: "another selection", text: "different payload" }, {}]
        : [{ query: "BAD" }, { query: "different query" }]) {
        const rejected: Call = {
          tool: refusal.tool,
          args: { path: { id: uuid }, ...extras },
          error: true,
          text: refusal.contains ?? "refused",
        };
        assert.ok(check(route, [issued, rejected], mode));
        assert.ok(!check(route, [issued, { ...rejected, error: false }], mode));
        assert.ok(!check(route, [issued], mode));
        assert.ok(!check(route, [issued, { ...rejected, tool: "delete" }], mode));
        for (const path of ["task.txt", { id: "99999999-aaaa-4aaa-8aaa-999999999999" }]) {
          assert.ok(
            !check(route, [issued, { ...rejected, args: { ...rejected.args, path } }], mode),
          );
        }
      }
    });
  }
}

for (const mode of ["direct", "codemode"]) {
  void test(`missing-selector refusals require argument shape, not payload spelling (${mode})`, () => {
    const route = steps("missing-edit-selector-recovery");
    const insert = route[0];
    const copy = route[3];
    assert.ok(insert && copy);
    const checkRefusal = (step: RouteStep, args: Record<string, unknown>, error = true) =>
      check(
        [{ ...step, after: undefined }],
        [{ tool: step.tool, args, error, text: step.contains }],
        mode,
      );
    assert.ok(checkRefusal(insert, { path: "task.txt", text: "different payload" }));
    assert.ok(!checkRefusal(insert, { path: "task.txt" }));
    assert.ok(!checkRefusal(insert, { path: "task.txt", anchor: "OLD", text: "added" }));
    assert.ok(!checkRefusal(insert, { path: "task.txt", text: "added" }, false));
    assert.ok(checkRefusal(copy, { path: "task.txt", start: "OLD\n", target: "target.txt" }));
    assert.ok(!checkRefusal(copy, { path: "task.txt", target: "target.txt" }));
    assert.ok(
      !checkRefusal(copy, {
        path: "task.txt",
        start: "OLD",
        target: "target.txt",
        targetStart: "DEST",
      }),
    );
    assert.ok(!checkRefusal(copy, { path: "wrong.txt", start: "OLD", target: "target.txt" }));
    assert.ok(!checkRefusal(copy, { path: "task.txt", start: "OLD", target: "target.txt" }, false));
  });
}

void test("ambiguous Insert list refusal does not depend on insertion direction", () => {
  const route = steps("insert-list-selectors-refused").slice(0, 3);
  const calls: Call[] = [
    { tool: "search", args: { path: "task.txt", query: "OLD" }, text: "SEARCH#ABCD:1:line" },
    { tool: "search", args: { path: "task.txt", query: "TAIL" }, text: "SEARCH#DCBA:1:line" },
    {
      tool: "insert",
      args: {
        path: ["SEARCH#ABCD:1:line", "SEARCH#DCBA:1:line"],
        anchor: "SEARCH#ABCD:1:line",
        text: "NEW",
      },
      error: true,
    },
  ];
  const rejected = calls[2];
  assert.ok(rejected);
  for (const before of [undefined, false, true]) {
    const attempt = {
      ...rejected,
      args: { ...rejected.args, ...(before === undefined ? {} : { before }) },
    };
    assert.ok(check(route, [...calls.slice(0, 2), attempt]));
    assert.ok(!check(route, [...calls.slice(0, 2), { ...attempt, error: false }]));
    assert.ok(
      !check(route, [
        ...calls.slice(0, 2),
        { ...attempt, args: { ...attempt.args, anchor: undefined } },
      ]),
    );
    assert.ok(
      !check(route, [
        ...calls.slice(0, 2),
        { ...attempt, args: { ...attempt.args, anchor: "SEARCH#FFFF:1:line" } },
      ]),
    );
  }
});
for (const mode of ["direct", "codemode"]) {
  void test(`standalone calls accept parsed reference objects and retain namespace ownership (${mode})`, () => {
    const searchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
    const route: RouteStep[] = [
      { tool: "demo_read", args: { path: "memory://demo/note", offset: 1, limit: 1 } },
      { tool: "demo_search", reuse: { from: 0, field: "path" } },
      { tool: "demo_replace", reuse: { from: 1, field: "path" } },
    ];
    const calls: Call[] = [
      {
        tool: "demo_read",
        args: { path: "memory://demo/note", offset: "1", limit: "1" },
        value: { id: result },
      },
      {
        tool: "demo_search",
        args: { path: JSON.stringify({ id: result.replace("RESULT#", "") }), query: "alpha" },
        value: { id: searchId },
      },
      {
        tool: "demo_replace",
        args: { path: JSON.stringify({ id: searchId.replace("RESULT#", "") }), text: "changed" },
      },
    ];
    assert.ok(check(route, calls, mode));
    assert.ok(
      !check(
        route,
        calls.map((call) => ({ ...call, tool: call.tool.replace("demo_", "other_") })),
        mode,
      ),
    );
    assert.ok(
      !check(
        route,
        calls.map((call, index) =>
          index === 1
            ? {
                ...call,
                args: {
                  path: JSON.stringify({ id: "ffffffff-aaaa-4aaa-8aaa-111111111111" }),
                  query: "alpha",
                },
              }
            : call,
        ),
        mode,
      ),
    );
    assert.ok(
      !check(
        route,
        calls.map((call, index) =>
          index === 1 ? { ...call, args: { path: "memory://demo/note", query: "alpha" } } : call,
        ),
        mode,
      ),
    );
  });
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
for (const mode of ["direct", "codemode"]) {
  void test(`lsp-read accepts a recovered references call after independent operations in ${mode}`, () => {
    const route = steps("lsp-read");
    const query: Call = {
      tool: "lsp_search",
      args: { path: "task.ts", query: "count" },
      text: `<uuid>${uuid}</uuid>\ncount`,
      value: { id: result },
    };
    const references: Call = {
      tool: "lsp_search",
      args: { path: result, query: "count", references: true },
      text: "count",
    };
    const independent: Call[] = [
      { tool: "lsp_search", args: { declaration: "task.ts#count" }, text: "3" },
      { tool: "lsp_search", args: { calls: "task.ts#count" }, text: "References" },
      {
        tool: "diagnostics",
        args: { path: "problem.ts" },
        text: "typescript-language-server:2322",
      },
      {
        tool: "read",
        args: { path: "problem.ts", views: ["diagnostics"] },
        text: "typescript-language-server:2322",
      },
    ];
    const recovered = [query, { ...references, error: true }, ...independent, references];
    assert.ok(check(route, recovered, mode));
    assert.ok(check(route, [...independent.toReversed(), query, references], mode));
    for (const call of [query, references, ...independent]) {
      assert.ok(
        !check(
          route,
          recovered.filter((entry) => entry !== call),
          mode,
        ),
        call.tool,
      );
    }
    assert.ok(!check(route, [references, ...independent, query], mode));
    assert.ok(
      !check(
        route,
        [query, ...independent, { ...references, args: { ...references.args, path: "task.ts" } }],
        mode,
      ),
    );
  });

  void test(`independent requirements need distinct successful executions in ${mode}`, () => {
    const repeated: RouteStep[] = [{ tool: "read" }, { tool: "read" }];
    const read: Call = { tool: "read", args: { path: "task.txt" } };
    assert.ok(!check(repeated, [read], mode));
    assert.ok(!check(repeated, [read, { ...read, error: true }], mode));
    assert.ok(check(repeated, [read, read], mode));
    const ordered: RouteStep[] = [{ tool: "write" }, { tool: "read", after: [0] }];
    const write: Call = { tool: "write", args: { path: "task.txt", content: "new" } };
    assert.ok(check(ordered, [write, read], mode));
    assert.ok(!check(ordered, [read, write], mode));
    const skipped: RouteStep[] = [
      { tool: "write", modes: ["other"] },
      ordered[1] ?? { tool: "read" },
    ];
    assert.ok(!check(skipped, [write, read], mode));
  });
}

void test("parallel requirements accept either start order but never disjoint executions", () => {
  const route: RouteStep[] = [{ tool: "read" }, { tool: "search", parallelWith: 0 }];
  const calls: Call[] = [
    { tool: "read", args: {} },
    { tool: "search", args: {} },
  ];
  const entries = events(calls, "codemode");
  const [parent, readStart, readEnd, searchStart, searchEnd, parentEnd] = entries;
  assert.ok(parent && readStart && readEnd && searchStart && searchEnd && parentEnd);
  for (const middle of [
    [readStart, searchStart, readEnd, searchEnd],
    [searchStart, readStart, searchEnd, readEnd],
  ])
    assert.ok(validateRoute({ steps: route }, [parent, ...middle, parentEnd], "codemode").passed);
  for (const middle of [
    [readStart, readEnd, searchStart, searchEnd],
    [searchStart, searchEnd, readStart, readEnd],
  ])
    assert.ok(!validateRoute({ steps: route }, [parent, ...middle, parentEnd], "codemode").passed);
});
void test("the free gate rejects invalid or forward explicit dependencies", () => {
  const task = {
    id: "dependency-fixture",
    capabilities: [],
    modes: ["direct"],
    steps: [{ tool: "write" }, { tool: "read", after: [0] }],
  };
  assert.deepEqual(checkCoverage([], [task], []), []);
  for (const after of [[-1], [1], [2], [0.5]]) {
    assert.equal(
      checkCoverage(
        [],
        [{ ...task, steps: [task.steps[0] ?? { tool: "write" }, { tool: "read", after }] }],
        [],
      ).length,
      1,
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
  void test(`deferred navigation accepts Undo's inferred file in ${mode}`, () => {
    const route = steps("deferred-navigation-recovery");
    const prefix = mode === "direct" ? [discoveryCall] : [];
    const withUndo = (args: Record<string, unknown>) =>
      check(
        route,
        [
          ...prefix,
          ...deferredCalls.map((call) => (call.tool === "undo" ? { ...call, args } : call)),
        ],
        mode,
      );
    assert.ok(withUndo({ change: "last" }));
    assert.ok(withUndo({ file: "task.txt", change: "last" }));
    assert.ok(!withUndo({}));
    assert.ok(!withUndo({ change: "CHANGE#ABCD" }));
  });
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
    const prerequisite: Call = { tool: "fixture_prerequisite", args: {} };
    const route = [{ tool: prerequisite.tool }, step];
    assert.ok(check(route, [prerequisite, call]));
    assert.ok(!check(route, [prerequisite, { ...call, args: { ...args, offset: 2 } }]));
    assert.ok(!check(route, [prerequisite, { ...call, args: { ...args, limit: 99 } }]));
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
  void test(`read-window-insert checks its Read result and final bytes in ${mode}`, async () => {
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
      const withPaths = (path: string | string[]): Call => ({
        ...read,
        args: { ...read.args, path },
        value: Array.isArray(path)
          ? path.map((file) =>
              file === "task.txt"
                ? read.value
                : {
                    id: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
                    text: "OTHER\n",
                  },
            )
          : read.value,
      });
      for (const path of ["task.txt", ["task.txt"], ["other.txt", "task.txt"]]) {
        assert.ok(check(route, [withPaths(path), insert], mode));
      }
      assert.ok(
        !check(
          route.map((step) =>
            step.tool === "insert" ? { ...step, args: { ...step.args, path: "task.txt" } } : step,
          ),
          [{ ...read, args: { ...read.args, path: ["other.txt", "task.txt"] } }, insert],
          mode,
        ),
      );
      assert.ok(!check(route, [insert], mode));
      for (const args of [
        { ...read.args, path: ["other.txt"] },
        { ...read.args, path: ["other.txt", "task.txt"], offset: 1 },
        { ...read.args, path: ["other.txt", "task.txt"], limit: 2 },
      ]) {
        assert.ok(!check(route, [{ ...withPaths(args.path), args }, insert], mode));
      }
      assert.ok(!check(route, [{ ...read, error: true }, insert], mode));
      for (const path of ["task.txt", "RESULT#22222222-aaaa-4aaa-8aaa-222222222222"]) {
        assert.ok(!check(route, [read, { ...insert, args: { ...insert.args, path } }], mode));
      }
    }
    assert.ok(await outputPasses("read-window-insert", "keep\nBEFORE\nOLD\nlast\n"));
    for (const text of ["BEFORE\n\n", "BEFORE ", "OTHER"]) {
      assert.ok(
        check(route, [read, { tool: "insert", args: { path: source, before: true, text } }], mode),
      );
      const inserted = text.endsWith("\n") ? text : `${text}\n`;
      assert.equal(await outputPasses("read-window-insert", `keep\n${inserted}OLD\nlast\n`), false);
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
        {
          ...read,
          args: { path, views: ["anchors"] },
          text: Array.isArray(path)
            ? path
                .map(
                  (source) =>
                    `--- ${source} ---\n${source.endsWith("/source") ? "ABCDEFG|print(value)" : "debug:abcd"}`,
                )
                .join("\n\n")
            : read.text,
        },
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

void test("shifted repeated-line route checks issued anchors and final line separation", async () => {
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
    check(route, [
      calls[0],
      { ...calls[1], args: { ...calls[1].args, text: "top\n\n" } },
      calls[2],
    ]),
  );
  const expected = "top\nalpha\nfn one() {\n  work();\n}\nfn two() {\n  more();\n";
  assert.ok(await outputPasses("repeated-line-anchor-after-shift", expected));
  assert.equal(
    await outputPasses("repeated-line-anchor-after-shift", expected.replace("top\n", "top\n\n")),
    false,
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
          { ...calls[1], args: { ...calls[1].args, start: "SEARCH#ABCD:1:line" } },
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
          { ...calls[1], args: { path: "block.txt", start: undefined } },
          ...calls.slice(2),
        ],
        "codemode",
      ),
    );
  });
}

void test("token edit accepts an issued selection in start but rejects fabricated provenance", () => {
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
  for (const start of [result, "SEARCH#FFFF:1:match"]) {
    assert.ok(
      !check(route, [
        ...calls.slice(0, 3),
        { ...calls[3], args: { start, text: "GREEN" } },
        ...calls.slice(4),
      ]),
    );
  }
});

void test("whole Search scopes preserve individual-match route equivalence", () => {
  const route: RouteStep[] = [
    { tool: "search", args: { path: "task.txt", query: "red OR blue" } },
    { tool: "replace", args: { path: /^SEARCH#ABCD:1:match$/u, text: "RED" } },
  ];
  const search: Call = {
    tool: "search",
    args: { path: "task.txt", query: "red OR blue" },
    text: `<uuid>${uuid}</uuid>\nSEARCH#ABCD:1:match\nSEARCH#ABCD:2:match`,
    value: {
      id: uuid,
      complete: true,
      matches: [
        {
          id: "RESULT#22222222-aaaa-4aaa-8aaa-222222222222",
          path: "task.txt",
          references: { match: "SEARCH#ABCD:1:match" },
        },
        {
          id: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
          path: "task.txt",
          references: { match: "SEARCH#ABCD:2:match" },
        },
      ],
    },
  };
  for (const mode of ["direct", "codemode"]) {
    for (const path of [{ id: uuid }, result]) {
      for (const end of [undefined, "SEARCH#ABCD:1:match"]) {
        const args = { path, start: "SEARCH#ABCD:1:match", ...(end && { end }), text: "RED" };
        assert.ok(check(route, [search, { tool: "replace", args }], mode));
      }
    }
    for (const args of [
      { path: { id: "44444444-aaaa-4aaa-8aaa-444444444444" }, start: "SEARCH#ABCD:1:match" },
      { path: { id: uuid }, start: "SEARCH#FFFF:1:match" },
      { path: { id: uuid }, start: "SEARCH#ABCD:1:match", end: "SEARCH#ABCD:2:match" },
      { path: { id: uuid }, start: "SEARCH#ABCD:1:match", end: "SEARCH#FFFF:1:match" },
    ])
      assert.ok(!check(route, [search, { tool: "replace", args: { ...args, text: "RED" } }], mode));
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
