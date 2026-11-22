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
  loaded?: string[];
}
function events(calls: Call[], mode: string): RunEvent[] {
  const children: RunEvent[] = calls.flatMap((call, index) => [
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
        details: { loaded: call.loaded },
      },
    },
  ]);
  return mode === "direct"
    ? children
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...children,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}
for (const mode of ["direct", "codemode"]) {
  for (const tool of ["read", "demo_read", "other_read"]) {
    void test(`${mode}: ${tool} treats omitted text and raw offsets as defaults`, () => {
      for (const [path, offset] of [
        ["task.txt", 1],
        ["raw:task.txt", 0],
      ] as const) {
        const steps: RouteStep[] = [{ tool, args: { path, offset, limit: 1 } }];
        const retained = events([{ tool, args: { path, limit: 1 } }], mode);
        const original = structuredClone(retained);
        assert.ok(validateRoute({ steps }, retained, mode).passed);
        assert.deepEqual(retained, original);
        for (const args of [
          { path, offset: offset + 1, limit: 1 },
          { path, offset },
          { path, offset, limit: 2 },
        ])
          assert.equal(
            validateRoute({ steps }, events([{ tool, args }], mode), mode).passed,
            false,
          );
      }
    });
  }
  void test(`${mode}: explicit Search limit and boolean defaults may be omitted`, () => {
    for (const tool of ["search", "demo_search", "other_search"]) {
      const steps: RouteStep[] = [
        {
          tool,
          args: {
            path: "task.txt",
            query: "value",
            limit: mode === "codemode" ? Number.MAX_SAFE_INTEGER : 50,
            caseSensitive: false,
            wholeWord: false,
            multiline: false,
          },
        },
      ];
      assert.ok(
        validateRoute(
          { steps },
          events([{ tool, args: { path: "task.txt", query: "value" } }], mode),
          mode,
        ).passed,
      );
      assert.equal(
        validateRoute(
          { steps },
          events([{ tool, args: { path: "task.txt", query: "value", limit: 49 } }], mode),
          mode,
        ).passed,
        false,
      );
    }
  });
  void test(`${mode}: Search defaults keep resolver limits distinct`, () => {
    for (const [path, limit] of [
      ["docs:guide", 50],
      ["shell:session", 100],
      ["task.txt", mode === "codemode" ? Number.MAX_SAFE_INTEGER : 50],
    ] as const) {
      const task = { steps: [{ tool: "search", args: { path, query: "value", limit } }] };
      assert.ok(
        validateRoute(
          task,
          events([{ tool: "search", args: { path, query: "value" } }], mode),
          mode,
        ).passed,
      );
      assert.equal(
        validateRoute(
          task,
          events([{ tool: "search", args: { path, query: "value", limit: limit - 1 } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    for (const path of ["memory://demo/note", "RESULT#11111111-aaaa-4aaa-8aaa-111111111111"]) {
      assert.equal(
        validateRoute(
          { steps: [{ tool: "search", args: { path, limit: 50 } }] },
          events([{ tool: "search", args: { path } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    for (const flag of ["caseSensitive", "wholeWord", "multiline"]) {
      assert.equal(
        validateRoute(
          { steps: [{ tool: "search", args: { [flag]: true } }] },
          events([{ tool: "search", args: { path: "task.txt", query: "value" } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    assert.equal(
      validateRoute(
        { steps: [{ tool: "demo_read", args: { path: "task.txt", offset: 1 } }] },
        events([{ tool: "other_read", args: { path: "task.txt" } }], mode),
        mode,
      ).passed,
      false,
    );
  });
  void test(`${mode}: array Read keeps output and selection evidence with its source`, () => {
    const paths = ["a.txt", "b.txt"];
    const read: Call = {
      tool: "read",
      args: { path: paths, views: ["anchors"] },
      text: "--- a.txt ---\nBCDEFGH|Alpha\n\n--- b.txt ---\nABCDEFG|Beta\n",
    };
    const readStep: RouteStep = { tool: "read", args: { path: "b.txt" }, contains: "Beta" };
    const editStep: RouteStep = {
      tool: "delete",
      args: { path: "b.txt", at: /^ABCDEFG$/u },
      reuse: { from: 0, field: "at", kind: "anchor" },
    };
    const task = { steps: [readStep, editStep] };
    const edit: Call = { tool: "delete", args: { path: "b.txt", at: "ABCDEFG" } };
    assert.ok(validateRoute(task, events([read, edit], mode), mode).passed);
    assert.equal(
      validateRoute(
        { steps: [{ tool: "read", args: { path: "a.txt" }, contains: "Beta" }] },
        events([read], mode),
        mode,
      ).passed,
      false,
    );
    assert.ok(read.text);
    for (const text of [
      read.text.replace("--- b.txt ---", "--- other.txt ---"),
      read.text.replace("--- a.txt ---", "--- b.txt ---"),
      read.text + "\n--- b.txt ---\nABCDEFG|Beta",
      "--- a.txt ---\nABCDEFG|Beta\n\n--- b.txt ---\nBCDEFGH|Alpha",
    ]) {
      assert.equal(
        validateRoute(task, events([{ ...read, text }, edit], mode), mode).passed,
        false,
      );
    }
    assert.equal(
      validateRoute(
        { steps: [{ ...readStep, args: { path: "a.txt" }, contains: "Alpha" }, editStep] },
        events([read, edit], mode),
        mode,
      ).passed,
      false,
    );
    const resultTask = {
      steps: [
        { tool: "read", args: { path: "b.txt" } },
        {
          tool: "replace",
          args: { path: "b.txt", text: "Changed" },
          reuse: { from: 0, field: "path" },
        },
      ],
    };
    const a = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
    const b = "RESULT#33333333-aaaa-4aaa-8aaa-333333333333";
    const valued = {
      ...read,
      value: [
        { id: a, text: "Alpha" },
        { id: b, text: "Beta" },
      ],
    };
    assert.ok(
      validateRoute(
        resultTask,
        events([valued, { tool: "replace", args: { path: b, text: "Changed" } }], mode),
        mode,
      ).passed,
    );
    for (const path of [a, "RESULT#11111111-aaaa-4aaa-8aaa-111111111111"]) {
      assert.equal(
        validateRoute(
          resultTask,
          events([valued, { tool: "replace", args: { path, text: "Changed" } }], mode),
          mode,
        ).passed,
        false,
      );
    }
  });
  for (const ending of ["lf", "crlf", "unterminated"]) {
    void test(`${mode}: exact EOF accepts array Read anchors only from the selected source`, () => {
      const task = capabilityCases.find((entry) => entry.id === `exact-eof-${ending}`);
      assert.ok(task);
      const eol = ending === "crlf" ? "\r\n" : "\n";
      const paths = ["last.txt", "block.txt", "empty.txt", "line.txt"];
      const texts = ["BCDEFGH|Last", "CDEFGHJ|Block", "DEFGHJK|Block", "ABCDEFG|Last"];
      const read: Call = {
        tool: "read",
        args: { path: paths, views: ["anchors"] },
        text: paths.map((path, index) => `--- ${path} ---\n${texts[index]}\n`).join("\n"),
      };
      const edits: Call[] = [
        { tool: "replace", args: { path: "last.txt", at: "Last", text: "Final" } },
        { tool: "delete", args: { path: "block.txt", at: `${eol}Last${eol}Block` } },
        {
          tool: "replace",
          args: { path: "empty.txt", at: `${eol}Last${eol}Block`, text: "" },
        },
        { tool: "delete", args: { path: "line.txt", at: "ABCDEFG" } },
        { tool: "replace", args: { path: "blank.txt", at: "Last", text: "\n" } },
      ];
      const representations: Call[] = [
        read,
        {
          ...read,
          value: texts.map((text, index) => ({
            id: `RESULT#11111111-aaaa-4aaa-8aaa-11111111111${index}`,
            text,
          })),
        },
      ];
      for (const issuer of representations) {
        assert.ok(validateRoute(task, events([issuer, ...edits], mode), mode).passed);
        for (const start of ["BCDEFGH", "ZZZZZZZ", "Last"])
          assert.equal(
            validateRoute(
              task,
              events(
                [
                  issuer,
                  ...edits.slice(0, 3),
                  {
                    tool: "delete",
                    args: { path: "line.txt", at: start },
                  },
                  ...edits.slice(4),
                ],
                mode,
              ),
              mode,
            ).passed,
            false,
          );
        assert.equal(validateRoute(task, events(edits, mode), mode).passed, false);
        assert.equal(
          validateRoute(task, events([{ ...issuer, error: true }, ...edits], mode), mode).passed,
          false,
        );
      }
    });
  }
}
void test("standalone discovery may load each tool before its first use", () => {
  const task = capabilityCases.find((entry) => entry.id === "standalone-resource-host");
  assert.ok(task);
  const readId = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
  const searchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
  const calls: Call[] = [
    { tool: "tool_search", args: {}, loaded: ["demo_copy", "demo_search", "demo_read"] },
    { tool: "demo_read", args: { path: "memory://demo/note", limit: 1 }, text: `alpha ${readId}` },
    { tool: "demo_search", args: { path: readId, query: "alpha" }, text: `alpha ${searchId}` },
    { tool: "tool_search", args: {}, loaded: ["demo_replace"] },
    { tool: "demo_replace", args: { path: searchId, text: "changed" } },
    {
      tool: "demo_read",
      args: { path: "local.txt" },
      error: true,
      text: "RESOURCE_HOST_LOCAL_PATH",
    },
    {
      tool: "demo_read",
      args: { path: "memory://other/note" },
      error: true,
      text: "RESOURCE_HOST_FOREIGN_SOURCE",
    },
    {
      tool: "demo_copy",
      args: { path: "memory://demo/note", target: "local.txt" },
      error: true,
      text: "RESOURCE_HOST_LOCAL_PATH",
    },
    { tool: "demo_read", args: { path: "memory://demo/note" }, text: "changed\nomega" },
  ];
  assert.ok(validateRoute(task, events(calls, "direct"), "direct").passed);
  for (const changed of [
    calls.filter((_, index) => index !== 3),
    [...calls.slice(0, 3), calls[4] as Call, calls[3] as Call, ...calls.slice(5)],
    calls.map((call, index) => (index === 3 ? { ...call, error: true } : call)),
  ])
    assert.equal(validateRoute(task, events(changed, "direct"), "direct").passed, false);
  const overlapping = events(calls, "direct");
  const discoveryEnd = overlapping.splice(7, 1)[0];
  assert.ok(discoveryEnd);
  overlapping.splice(9, 0, discoveryEnd);
  assert.equal(validateRoute(task, overlapping, "direct").passed, false);
  assert.equal(
    validateRoute(
      task,
      events(
        calls.filter((call) => call.tool !== "tool_search"),
        "direct",
      ),
      "direct",
    ).passed,
    false,
  );
  assert.equal(
    validateRoute(
      task,
      events(
        calls.filter((_, index) => index !== 2),
        "direct",
      ),
      "direct",
    ).passed,
    false,
  );
});
