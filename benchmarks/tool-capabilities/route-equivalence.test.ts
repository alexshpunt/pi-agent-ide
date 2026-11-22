import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFiles } from "./sandbox.ts";
import { capabilityCases } from "./cases.ts";
import { checkCoverage, validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

for (const mode of ["direct", "codemode"]) {
  void test(`whole-line transfers require literal sources and accept issued destinations (${mode})`, () => {
    const task = capabilityCases.find((entry) => entry.id === "exact-range-copy");
    assert.ok(task);
    const route = task.steps.slice(3, 5).map((step) => ({ ...step, sameAssistantWith: undefined }));
    const calls: Call[] = [
      { tool: "read", args: { path: "whole.txt", views: ["anchors"] }, text: "T286A4V|段🙂" },
      {
        tool: "read",
        args: { path: "inserted.txt", views: ["anchors"] },
        text: "6QG98NT|ANCHOR\n",
      },
      {
        tool: "copy",
        args: {
          path: "whole.txt",
          at: "段🙂\r\n",
          target: "inline.txt",
          targetAt: "SLOT",
        },
      },
      {
        tool: "copy",
        args: {
          path: "whole.txt",
          at: "段🙂\r\n",
          target: "inserted.txt",
          targetAfter: "6QG98NT",
        },
      },
    ];
    const checked = validateRoute({ ...task, steps: route }, events(calls, mode), mode);
    assert.ok(checked.passed, JSON.stringify(checked));
    for (const index of [2, 3]) {
      const issuedSource = calls.map((call, at) =>
        at === index ? { ...call, args: { ...call.args, at: "T286A4V" } } : call,
      );
      assert.equal(
        validateRoute({ ...task, steps: route }, events(issuedSource, mode), mode).passed,
        false,
      );
    }
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
              at: result,
              target: "inline.txt",
              targetAt: "SLOT",
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
        args: {
          path: "task.txt",
          from: "S5BM5NA|alpha",
          through: "FDCR4F0|beta",
          targetAfter: "});",
        },
        error: true,
        text: "7EQS4MN|INSERT_HERE",
      },
      {
        tool: "copy",
        args: {
          path: "task.txt",
          from: "S5BM5NA|alpha",
          through: "FDCR4F0|beta",
          targetAfter: "7EQS4MN|INSERT_HERE",
        },
      },
    ];
    const task = capabilityCases.find((entry) => entry.id === "copy-destination-recovery");
    assert.ok(task);
    const route = task.steps;
    const checked = validateRoute(task, events(calls, mode), mode);
    assert.ok(checked.passed, checked.reasons.join("\n"));
    assert.ok(
      !check(
        route,
        calls.map((call) => (call.error ? { ...call, text: "" } : call)),
        mode,
      ),
    );
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
            ...calls[2],
            tool: "copy",
            args: { path: "task.txt", from: "alpha", through: "beta", targetAfter: "INSERT_HERE" },
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
    { tool: "insert", args: { path: "task.txt", before: "alpha", text: "added" } },
    { tool: "replace", args: { path: { id: result }, text: "BETA" } },
    { tool: "delete", args: { path: "task.txt", at: "gamma\n" } },
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
    batch([...calls.slice(0, 3), { ...calls[3], args: { path: "task.txt", at: "gamma" } }]),
  );
  for (const start of [undefined, "SEARCH#ABCD:1:line", "regex:gamma"])
    assert.ok(
      !batch([...calls.slice(0, 3), { ...calls[3], args: { path: "task.txt", at: start } }]),
    );
  assert.ok(!batch(calls, 2));
  assert.ok(
    !batch([
      ...calls.slice(0, 2),
      { ...calls[2], args: { path: "task.txt", at: "beta", text: "BETA" } },
      calls[3],
    ]),
  );
  assert.ok(!batch([...calls.slice(0, 3), { ...calls[3], error: true }]));
});

void test("explicit-path scope retry is independent of the failed result-bound edit", () => {
  const calls: [Call, Call, Call] = [
    { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 }, text: `<uuid>${uuid}</uuid>` },
    { tool: "replace", args: { path: result, at: "last", text: "BAD" }, error: true },
    { tool: "replace", args: { path: "task.txt", at: "last", text: "fixed" } },
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
      { ...calls[2], args: { path: "other.txt", at: "last", text: "fixed" } },
    ]),
  );
  assert.ok(
    !check(task.steps, [
      calls[0],
      calls[1],
      // The real tool refuses this selection: last is outside the line-2 window.
      { ...calls[2], args: { path: result, at: "last", text: "fixed" }, error: true },
    ]),
  );
});

for (const mode of ["direct", "codemode"]) {
  void test(`undo-last accepts an inferred file and requires restoration in ${mode}`, () => {
    const task = capabilityCases.find((entry) => entry.id === "undo-last");
    assert.ok(task);
    const calls: [Call, Call, Call] = [
      { tool: "replace", args: { path: "task.txt", at: "OLD", text: "NEW" } },
      { tool: "undo", args: { change: "last" } },
      { tool: "read", args: { path: "task.txt" }, text: task.files?.["task.txt"] },
    ];
    for (const args of [{ change: "last" }, { file: "task.txt", change: "last" }])
      assert.ok(check(task.steps, [calls[0], { ...calls[1], args }, calls[2]], mode));
    for (const args of [{}, { change: "CHANGE#ABCD" }])
      assert.ok(!check(task.steps, [calls[0], { ...calls[1], args }, calls[2]], mode));
    assert.ok(!check(task.steps, [calls[0], { ...calls[1], error: true }, calls[2]], mode));
    assert.ok(!check(task.steps, [calls[1], calls[0], calls[2]], mode));
    assert.ok(!check(task.steps, [calls[0], calls[2], calls[1]], mode));
    assert.ok(!check(task.steps, [calls[0], calls[1], { ...calls[2], text: "NEW" }], mode));
  });
}
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
      text: `<system-result><uuid>${uuid}</uuid></system-result>\n${sources
        .map(() => "--- shell:input-check ---\nhello\nSHELL-FINAL-LINE")
        .join("\n")}`,
    },
    {
      tool: "replace",
      args: { path: result, at: "hello", text: "BAD" },
      error: true,
      text: steps("shell-roundtrip").find((step) => step.tool === "replace")?.contains,
    },
    { tool: "search", args: { path: "shell:input-check", query: "hello" }, text: "hello" },
    { tool: "delete", args: { path: "shell:input-check" } },
  ];
  const route = steps("shell-roundtrip");
  assert.ok(check(route, calls));
  assert.ok(
    !check(route, [
      ...calls.slice(0, 3),
      { ...calls[3], text: calls[3].text?.replaceAll("\nSHELL-FINAL-LINE", "") },
      ...calls.slice(4),
    ]),
  );
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

void test("direct array Read headers resolve only completed successful source references", () => {
  const a = "22222222-aaaa-4aaa-8aaa-222222222222";
  const b = "33333333-aaaa-4aaa-8aaa-333333333333";
  const route: RouteStep[] = [
    { tool: "search", args: { path: "a.txt" } },
    { tool: "search", args: { path: "b.txt" } },
    { tool: "read", reuse: { from: 0, field: "path" }, contains: "apple" },
    { tool: "read", reuse: { from: 1, field: "path" }, contains: "berry" },
  ];
  const calls: [Call, Call, Call] = [
    { tool: "search", args: { path: "a.txt" }, text: `<uuid>${a}</uuid>` },
    { tool: "search", args: { path: "b.txt" }, text: `<uuid>${b}</uuid>` },
    {
      tool: "read",
      args: { path: [{ id: a }, { id: b }] },
      text: "--- a.txt ---\napple\n--- b.txt ---\nberry",
    },
  ];
  assert.ok(check(route, calls));
  for (const text of [
    "--- b.txt ---\napple\n--- a.txt ---\nberry",
    "--- a.txt ---\napple\n--- a.txt ---\nberry",
    "--- a.txt ---\nberry\n--- b.txt ---\napple",
    "--- a.txt ---\napple berry",
  ])
    assert.ok(!check(route, [calls[0], calls[1], { ...calls[2], text }]));
  for (const index of [0, 1])
    assert.ok(
      !check(
        route,
        calls.map((call, at) => (at === index ? { ...call, error: true } : call)),
      ),
    );
  assert.ok(!check(route, [calls[0], calls[2], calls[1]]));
  assert.ok(
    !check(route, [
      calls[0],
      calls[1],
      {
        ...calls[2],
        args: { path: [{ id: a }, { id: uuid }] },
      },
    ]),
  );
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
    { tool: "insert", args: { path: { id: result }, text: "\nNEW\n" } },
  ];
  const route = steps("search-anchor-insert");
  assert.ok(check(route, calls, "codemode"));
  assert.ok(await outputPasses("search-anchor-insert", "keep\nOLD\nNEW\nlast\n"));
  for (const text of ["NEW", "\n\nNEW", "\nOTHER"]) {
    assert.ok(
      check(route, [calls[0], { ...calls[1], args: { ...calls[1].args, text: text } }], "codemode"),
    );
    assert.equal(await outputPasses("search-anchor-insert", `keep\nOLD${text}\nlast\n`), false);
  }
  assert.ok(
    !check(
      route,
      [calls[0], { ...calls[1], args: { path: "task.txt", after: "OLD", text: "\nNEW" } }],
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
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-insert-outcome-"));
  try {
    await Promise.all(
      Object.entries({ ...task.files, ...task.expected, "task.txt": text }).map(([name, value]) =>
        writeFile(path.join(root, name), value),
      ),
    );
    const initial = Object.fromEntries(
      Object.entries(task.files ?? {}).map(([name, value]) => [name, Buffer.from(value)]),
    );
    return (await validateFiles(root, initial, task.expected)).length === 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
for (const mode of ["direct", "codemode"]) {
  void test(`LSP selector file paths are equivalent without changing symbol fragments (${mode})`, () => {
    const selectors: [string, string, string][] = [
      ["read-symbol-delete", "declaration", "task.ts#doomed"],
      ["rust-diagnostics-no-build", "declaration", "src/main.rs#main"],
      ["lsp-read", "declaration", "task.ts#count"],
      ["lsp-read", "calls", "task.ts#count"],
      ["lsp-read", "calls", "task.ts"],
      ["lsp-rename", "declaration", "task.ts#count"],
      ["lsp-overload-rename", "declaration", "main.cpp#clamp"],
      ["lsp-overload-rename", "declaration", "main.cpp#clamp(const Vec&, float, float)"],
      ["lsp-calls-script-value", "calls", "task.ts#save"],
    ];
    for (const [id, field, selector] of selectors) {
      const matching = steps(id).filter((step) => step.args?.[field] !== undefined);
      const selected = matching.find((step) => {
        const expected = step.args?.[field];
        return expected instanceof RegExp ? expected.test(selector) : expected === selector;
      });
      assert.ok(selected, `${id}: ${selector}`);
      const route = [{ tool: "lsp_search", args: selected.args }];
      for (const prefix of ["", "./", "/workspace/fixture/", "file:///workspace/fixture/"]) {
        const args = { [field]: prefix + selector };
        assert.ok(
          check(route, [{ tool: "lsp_search", args }], mode),
          `${id}: ${prefix}${selector}`,
        );
        assert.ok(
          !check(
            route,
            [{ tool: "lsp_search", args: { [field]: `/workspace/other/${selector}` } }],
            mode,
          ),
        );
      }
      if (!(selected.args?.[field] instanceof RegExp) || selector.includes("(const Vec")) {
        assert.ok(
          !check(
            route,
            [{ tool: "lsp_search", args: { [field]: selector.replace(/#[\s\S]*/, "#other") } }],
            mode,
          ),
        );
      }
    }
    const overload = steps("lsp-overload-rename")[1];
    assert.ok(overload);
    assert.ok(
      !check(
        [{ tool: "lsp_search", args: overload.args }],
        [
          {
            tool: "lsp_search",
            args: { declaration: "/workspace/fixture/main.cpp#clamp(int, int, int)" },
          },
        ],
        mode,
      ),
    );
  });

  void test(`changes Read accepts the issued Replace result and retains Git provenance (${mode})`, () => {
    const route = steps("git-stage-unstage-undo").map(({ tool, args, reuse, after }) => ({
      tool,
      args,
      reuse,
      after,
    }));
    for (const source of [
      "task.txt",
      "/workspace/fixture/task.txt",
      result,
      uuid,
      { id: result },
      [uuid],
    ]) {
      const calls: Call[] = [
        {
          tool: "replace",
          args: { path: "task.txt", at: "OLD", text: "NEW" },
          text: `<uuid>${uuid}</uuid>`,
        },
        { tool: "read", args: { path: source, views: ["changes"] }, text: "CHANGE#ABCD" },
        { tool: "stage", args: { change: "CHANGE#ABCD" } },
        { tool: "stage", args: { change: "CHANGE#ABCD" } },
        { tool: "read", args: { path: "task.txt", views: ["changes"] }, text: "CHANGE#BCDE" },
        { tool: "unstage", args: { change: "CHANGE#BCDE" } },
        { tool: "read", args: { path: "task.txt", views: ["changes"] }, text: "CHANGE#CDEF" },
        { tool: "undo", args: { change: "CHANGE#CDEF" } },
      ];
      const validation = validateRoute({ steps: route }, events(calls, mode), mode);
      assert.ok(validation.passed, `${JSON.stringify(source)}: ${validation.reasons.join("; ")}`);
      assert.ok(
        !check(
          route,
          calls.map((call, index) =>
            index === 2 ? { ...call, args: { change: "CHANGE#FFFF" } } : call,
          ),
          mode,
        ),
      );
    }
  });

  void test(`changes Read equivalence rejects missing, failed, late and ambiguous issuers (${mode})`, () => {
    const route: RouteStep[] = [{ tool: "read", args: { path: "task.txt", views: ["changes"] } }];
    const read: Call = { tool: "read", args: { path: uuid, views: ["changes"] } };
    const issuer: Call = {
      tool: "replace",
      args: { path: "task.txt" },
      text: `<uuid>${uuid}</uuid>`,
    };
    assert.ok(!check(route, [read], mode));
    assert.ok(!check(route, [read, issuer], mode));
    assert.ok(
      !check(
        route,
        [
          { ...issuer, text: "other.txt" },
          { ...read, args: { path: "other.txt", views: ["changes"] } },
        ],
        mode,
      ),
    );
    assert.ok(!check(route, [{ ...issuer, error: true }, read], mode));
    for (const path of ["other.txt", ["task.txt", "other.txt"]])
      assert.ok(!check(route, [{ ...issuer, args: { path } }, read], mode));
    const unfinished = events([issuer, read], mode).filter(
      (event) => !(event.type === "tool_execution_end" && event.toolCallId === `${mode}-0`),
    );
    assert.ok(!validateRoute({ steps: route }, unfinished, mode).passed);
    assert.ok(
      !check(
        [{ tool: "read", args: { path: "task.txt" } }],
        [issuer, { ...read, args: { path: uuid } }],
        mode,
      ),
    );
  });
}
for (const mode of ["direct", "codemode"]) {
  void test(`undo recipes accept Search-match edits without prescribing a selector (${mode})`, () => {
    for (const id of ["undo-last", "deferred-navigation-recovery"]) {
      const task = recipe(id);
      const firstEdit = task.steps.findIndex((step) => step.tool === "replace");
      const route = task.steps.slice(firstEdit).map((step) => ({
        ...step,
        after: step.after?.map((index) => index - firstEdit),
      }));
      const calls = [
        { tool: "search", args: { path: "task.txt", query: "OLD" }, text: "SEARCH#ABCD:1:match" },
        {
          tool: "replace",
          args: { path: "task.txt", at: "SEARCH#ABCD:1:match", text: "NEW" },
        },
        { tool: "undo", args: { change: "last" } },
        { tool: "read", args: { path: "task.txt" }, text: "OLD" },
      ] as const satisfies readonly Call[];
      const validate = (input: readonly Call[]) =>
        validateRoute({ ...task, steps: route }, events(input, mode), mode).passed;
      assert.ok(validate(calls), id);
      assert.ok(!validate([calls[0], { ...calls[1], error: true }, ...calls.slice(2)]), id);
      assert.ok(
        !validate([
          calls[0],
          { ...calls[1], args: { ...calls[1].args, text: "OLD" } },
          ...calls.slice(2),
        ]),
        id,
      );
      assert.ok(!validate(calls.filter((call) => call.tool !== "undo")), id);
    }
  });

  for (const ending of ["lf", "crlf"]) {
    void test(`heading boundary requires a single literal selector (${ending}, ${mode})`, () => {
      const route = steps(`replace-line-boundary-${ending}`).slice(0, 1);
      const call: Call = {
        tool: "replace",
        args: {
          path: "heading.txt",
          at: ending === "lf" ? "## OLD\n" : "## OLD\r\n",
          text: "## NEW",
        },
      };
      assert.ok(check(route, [call], mode));
      assert.ok(!check(route, [{ ...call, args: { ...call.args, at: undefined } }], mode));
      const search = selectionWitness("heading.txt", 1, "## OLD");
      assert.ok(
        !check(
          route,
          [search, { ...call, args: { ...call.args, at: "SEARCH#ABCD:1:line" } }],
          mode,
        ),
      );
    });
  }

  for (const ending of ["lf", "crlf", "unterminated"]) {
    void test(`EOF recipes distinguish literal replacement from issued-line deletion (${ending}, ${mode})`, () => {
      const task = recipe(`exact-eof-${ending}`);
      const [replace, , , readStep, deleteStep] = task.steps;
      assert.ok(replace && readStep && deleteStep);
      const first: Call = {
        tool: "replace",
        args: { path: "last.txt", at: "Last", text: "Final" },
      };
      const replaceRoute = { ...task, steps: [replace] };
      assert.ok(validateRoute(replaceRoute, events([first], mode), mode).passed);
      assert.ok(
        !validateRoute(
          replaceRoute,
          events([{ ...first, args: { ...first.args, through: "Last" } }], mode),
          mode,
        ).passed,
      );
      const search = selectionWitness("last.txt", 2, "Last");
      assert.ok(
        !validateRoute(
          replaceRoute,
          events([search, { ...first, args: { ...first.args, at: "SEARCH#ABCD:1:line" } }], mode),
          mode,
        ).passed,
      );
      const deleteRoute = {
        ...task,
        prompt: "",
        steps: [
          readStep,
          {
            ...deleteStep,
            reuse: { from: 0, field: ["path", "at"], kind: "anchor" as const },
          },
        ],
      };
      const read: Call = {
        tool: "read",
        args: { path: "line.txt", views: ["anchors"] },
        text: "A1B2C3D|First\nE4F5G6H|Last",
      };
      assert.ok(
        validateRoute(
          deleteRoute,
          events([read, { tool: "delete", args: { path: "line.txt", at: "E4F5G6H" } }], mode),
          mode,
        ).passed,
      );
      assert.ok(
        !validateRoute(
          deleteRoute,
          events([read, { tool: "delete", args: { path: "line.txt", at: "Last" } }], mode),
          mode,
        ).passed,
      );
    });
  }
}

void test("incidental Inserts do not prescribe a selector spelling", () => {
  for (const id of [
    "codemode-search-value-batch",
    "codemode-search-anchor-batch",
    "repeated-line-anchor-after-shift",
  ]) {
    const task = recipe(id);
    const insert = task.steps.find((step) => step.tool === "insert");
    assert.ok(insert);
    const route = [{ ...insert, after: undefined, editorBatchSize: undefined }];
    const search: Call = {
      tool: "search",
      args: { path: "task.txt", query: "alpha" },
      text: "SEARCH#ABCD:1:match",
    };
    assert.ok(
      validateRoute(
        { ...task, steps: route },
        events([
          search,
          {
            tool: "insert",
            args: {
              path: "task.txt",
              before: "SEARCH#ABCD:1:match",
              text: "top\n",
            },
          },
        ]),
        "direct",
      ).passed,
      id,
    );
    assert.ok(
      !validateRoute(
        { ...task, steps: route },
        events([
          {
            tool: "insert",
            args: { path: "task.txt", after: "alpha", text: "top\n" },
          },
        ]),
        "direct",
      ).passed,
      id,
    );
  }
});
function selectionWitness(source: string, line: number, text: string): Call {
  return {
    tool: "search",
    args: { path: source, query: text },
    text: "SEARCH#ABCD:1:line SEARCH#ABCD:1:match",
    value: {
      id: result,
      data: {
        complete: true,
        matches: [
          {
            target: "RESULT#22222222-aaaa-4aaa-8aaa-222222222222",
            source,
            range: { startLine: line, startColumn: 0, endLine: line, endColumn: text.length },
            matchedText: text,
            lineText: text,
            references: { line: "SEARCH#ABCD:1:line", match: "SEARCH#ABCD:1:match" },
          },
        ],
      },
    },
  };
}
function recipe(id: string) {
  const task = capabilityCases.find((entry) => entry.id === id);
  assert.ok(task);
  return { ...task, prompt: "" };
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
        ? [{ text: "BAD" }, { at: "another selection", text: "different payload" }, {}]
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
    assert.ok(!checkRefusal(insert, { path: "task.txt", after: "OLD", text: "added" }));
    assert.ok(!checkRefusal(insert, { path: "task.txt", text: "added" }, false));
    assert.ok(checkRefusal(copy, { path: "source.txt", at: "OLD\n", target: "target.txt" }));
    assert.ok(!checkRefusal(copy, { path: "source.txt", target: "target.txt" }));
    assert.ok(
      !checkRefusal(copy, {
        path: "source.txt",
        at: "OLD",
        target: "target.txt",
        targetAfter: "DEST",
      }),
    );
    assert.ok(!checkRefusal(copy, { path: "wrong.txt", at: "OLD", target: "target.txt" }));
    assert.ok(!checkRefusal(copy, { path: "source.txt", at: "OLD", target: "target.txt" }, false));
  });
}

void test("ambiguous Insert list refusal requires the issued selector", () => {
  const route = steps("insert-list-selectors-refused").slice(0, 3);
  const calls: Call[] = [
    { tool: "search", args: { path: "task.txt", query: "OLD" }, text: "SEARCH#ABCD:1:line" },
    { tool: "search", args: { path: "task.txt", query: "TAIL" }, text: "SEARCH#DCBA:1:line" },
    {
      tool: "insert",
      args: {
        path: ["SEARCH#ABCD:1:line", "SEARCH#DCBA:1:line"],
        before: "SEARCH#ABCD:1:line",
        text: "NEW",
      },
      error: true,
    },
  ];
  const rejected = calls[2];
  assert.ok(rejected);
  for (const attempt of [rejected]) {
    assert.ok(check(route, [...calls.slice(0, 2), attempt]));
    assert.ok(!check(route, [...calls.slice(0, 2), { ...attempt, error: false }]));
    assert.ok(
      !check(route, [
        ...calls.slice(0, 2),
        { ...attempt, args: { ...attempt.args, before: undefined } },
      ]),
    );
    assert.ok(
      !check(route, [
        ...calls.slice(0, 2),
        { ...attempt, args: { ...attempt.args, before: "SEARCH#FFFF:1:line" } },
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
        args: { path: { id: result.replace("RESULT#", "") }, query: "alpha" },
        value: { id: searchId },
      },
      {
        tool: "demo_replace",
        args: { path: { id: searchId.replace("RESULT#", "") }, text: "changed" },
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
  void test(`literal edit selectors and text match exactly, even on whole lines, in ${mode}`, () => {
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
    // A literal selects only its characters, so a terminal newline changes the edit's effect.
    for (const tool of ["insert", "delete", "replace", "copy", "move"]) {
      const selector = tool === "insert" ? "after" : "at";
      const extra = tool === "insert" || tool === "replace" ? { text: "NEW\n" } : {};
      const required = { [selector]: /^middle$/u, ...extra };
      assert.ok(edit(tool, required, { [selector]: "middle", ...extra }), tool);
      assert.ok(!edit(tool, required, { [selector]: "middle\n", ...extra }), tool);
      assert.ok(!edit(tool, required, { [selector]: "other", ...extra }), tool);
    }
    assert.ok(
      !edit("insert", { after: "middle", text: "NEW" }, { after: "middle", text: "NEW\n" }),
    );
    assert.ok(!edit("replace", { at: "middle", text: "NEW" }, { at: "middle", text: "NEW\n" }));
    assert.ok(!edit("replace", { at: "middle\n", text: "NEW\n" }, { at: "middle", text: "NEW" }));
    assert.ok(
      !edit("delete", { from: "fir", through: "middle" }, { from: "fir", through: "middle\n" }),
    );
    assert.ok(
      !edit(
        "insert",
        { before: "last", text: "NEW" },
        { before: "last", text: "NEW\n" },
        "first\nlast",
      ),
    );
  });
}
void test("Search :line replacement keeps the line only with its sent separator, never :match or fabricated provenance", () => {
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
          args: { at: /^SEARCH#[A-F0-9]+:1:line$/u, text: "BETA" + ending },
          reuse: { from: 0, field: "at" },
        },
      ],
    };
    const replace: Call = { tool: "replace", args: { at: line, text: "BETA" + ending } };
    assert.ok(validateRoute(task, events([search, replace], "codemode"), "codemode").passed);
    for (const changed of [
      { ...replace, args: { ...replace.args, at: "SEARCH#ABCD:1:match" } },
      { ...replace, args: { ...replace.args, at: "SEARCH#FFFF:1:line" } },
      { ...replace, args: { ...replace.args, text: "BETA" + ending + ending } },
      // Replace writes exactly its text: without the separator the line joins the next one.
      { ...replace, args: { ...replace.args, text: "BETA" } },
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
        {
          ...task.steps[1],
          tool: "replace",
          args: { at: "SEARCH#ABCD:1:match", text: "BETA" },
        },
      ],
    };
    assert.ok(
      !validateRoute(
        matchTask,
        events(
          [search, { ...replace, args: { at: "SEARCH#ABCD:1:match", text: "BETA" + ending } }],
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
  { tool: "replace", args: { path: "task.txt", at: "OLD", text: "NEW" } },
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
                field: step === steps("insert-before")[6] ? "before" : "after",
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
      { tool: "insert", args: { before: first, text: "[" } },
      {
        tool: "search",
        args: { path: "search.txt", query: "MATCH" },
        text: second,
        value: { matches: [{ id: second }] },
      },
      { tool: "insert", args: { after: second, text: "]" } },
    ] as const satisfies readonly Call[];
    assert.ok(check(route, calls, mode));
    for (const args of [
      { before: "SEARCH#FFFF:1:match", text: "[" },
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
    const route = steps("read-window-insert").slice(0, 2);
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", offset: 2, limit: 1 },
      text: `<uuid>${uuid}</uuid>\nOLD\n`,
      value: { id: result, text: "OLD\n" },
    };
    const source = mode === "codemode" ? read.value : result;
    for (const text of ["ADDED", "ADDED\n"]) {
      const insert: Call = { tool: "insert", args: { path: source, text: text } };
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
    assert.ok(await outputPasses("read-window-insert", "keep\nOLD\nADDED\nlast\n"));
    for (const text of ["ADDED\n\n", "ADDED ", "OTHER"]) {
      assert.ok(check(route, [read, { tool: "insert", args: { path: source, text: text } }], mode));
      const inserted = text.endsWith("\n") ? text : `${text}\n`;
      assert.equal(await outputPasses("read-window-insert", `keep\nOLD\n${inserted}last\n`), false);
    }
    assert.ok(
      !check(
        route,
        [read, { tool: "insert", args: { path: source, before: "OLD", text: "ADDED\n" } }],
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
    {
      tool: "insert",
      args: { path: "debug:abcd/source", after: "ABCDEFG", text: "breakpoint" },
    },
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
    { ...calls[3].args, after: "7654321" },
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
    { ...breakpoint, reuse: { from: 0, field: "after", kind: "anchor" } },
  ];
  const read: Call = {
    tool: "read",
    args: { path: "debug:abcd/source" },
    text: `<uuid>${uuid}</uuid>\nABCDEFG|print(value)`,
    value: { id: result, text: "ABCDEFG|print(value)" },
  };
  const edit: Call = {
    tool: "insert",
    args: { path: read.value, after: "ABCDEFG", text: "breakpoint" },
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
    { tool: "insert", args: { path: "task.txt", before: "ABCDEFG", text: "top" } },
    { tool: "delete", args: { path: "task.txt", at: "RSTVWXY" } },
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
  assert.equal(
    await outputPasses(
      "repeated-line-anchor-after-shift",
      expected.replace("top\nalpha", "alpha\ntop"),
    ),
    false,
  );
  assert.ok(
    !check(route, [calls[0], calls[1], { ...calls[2], args: { ...calls[2].args, at: "7654321" } }]),
  );
  assert.ok(
    !check(route, [
      calls[0],
      { ...calls[1], args: { ...calls[1].args, before: undefined, after: "ABCDEFG" } },
      calls[2],
    ]),
  );
});

for (const ending of ["lf", "crlf"]) {
  void test(`exact-eof-${ending} accepts a block selector including its terminal separator`, () => {
    const eol = ending === "lf" ? "\n" : "\r\n";
    const calls = [
      { tool: "replace", args: { path: "last.txt", at: "Last", text: "Final" } },
      { tool: "delete", args: { path: "block.txt", at: `Last${eol}Block${eol}` } },
      { tool: "replace", args: { path: "empty.txt", at: `Last${eol}Block${eol}`, text: "" } },
      { tool: "read", args: { path: "line.txt", views: ["anchors"] }, text: "ABCDEFG|Last" },
      { tool: "delete", args: { path: "line.txt", at: "ABCDEFG" } },
      { tool: "replace", args: { path: "blank.txt", at: "Last", text: "\n" } },
    ] as const satisfies readonly Call[];
    assert.ok(check(steps(`exact-eof-${ending}`), calls, "codemode"));
    assert.ok(
      !check(
        steps(`exact-eof-${ending}`),
        [
          calls[0],
          { ...calls[1], args: { ...calls[1].args, at: "SEARCH#ABCD:1:line" } },
          ...calls.slice(2),
        ],
        "codemode",
      ),
    );
    assert.ok(
      !check(
        steps(`exact-eof-${ending}`),
        [calls[0], { ...calls[1], args: { path: "block.txt", at: undefined } }, ...calls.slice(2)],
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
    { tool: "replace", args: { at: "SEARCH#ABCD:1:match", text: "GREEN" } },
    {
      tool: "search",
      args: { path: "literal.txt", query: "alpha beta" },
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
        const args = {
          path,
          ...(end ? { from: "SEARCH#ABCD:1:match", through: end } : { at: "SEARCH#ABCD:1:match" }),
          text: "RED",
        };
        assert.ok(check(route, [search, { tool: "replace", args }], mode));
      }
    }
    for (const args of [
      { path: { id: "44444444-aaaa-4aaa-8aaa-444444444444" }, at: "SEARCH#ABCD:1:match" },
      { path: { id: uuid }, at: "SEARCH#FFFF:1:match" },
      { path: { id: uuid }, from: "SEARCH#ABCD:1:match", through: "SEARCH#ABCD:2:match" },
      { path: { id: uuid }, from: "SEARCH#ABCD:1:match", through: "SEARCH#FFFF:1:match" },
    ])
      assert.ok(!check(route, [search, { tool: "replace", args: { ...args, text: "RED" } }], mode));
  }
});
void test("multiline replacement must reuse the first search, in path or at", () => {
  const route = steps("search-multiline-between");
  const calls = [
    {
      tool: "search",
      args: { path: "task.txt", query: "regex:old one\\nold two\\n(?=END)", multiline: true },
      text: "SEARCH#ABCD:1:line",
    },
    { tool: "search", args: { path: "task.txt", query: "keep" }, text: "SEARCH#DCBA:1:line" },
    { tool: "replace", args: { path: "task.txt", at: "SEARCH#ABCD:1:line", text: "NEW" } },
  ] as const satisfies readonly Call[];
  assert.ok(check(route, calls));
  for (const start of ["SEARCH#DCBA:1:line", "SEARCH#FFFF:1:line", "old one\nold two"]) {
    assert.ok(
      !check(route, [...calls.slice(0, 2), { ...calls[2], args: { ...calls[2].args, at: start } }]),
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
      args: { path: "RESULT#22222222-aaaa-4aaa-8aaa-222222222222", at: "NEW", text: "FINAL" },
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
