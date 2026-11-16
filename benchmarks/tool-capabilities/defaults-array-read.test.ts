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
            limit: 50,
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
        { tool: "replace", args: { path: "last.txt", start: "Last", text: "Final" } },
        { tool: "delete", args: { path: "block.txt", start: `${eol}Last${eol}Block` } },
        { tool: "replace", args: { path: "empty.txt", start: `${eol}Last${eol}Block`, text: "" } },
        { tool: "delete", args: { path: "line.txt", start: "ABCDEFG" } },
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
                    ...edits[3]!,
                    args: { path: "line.txt", start },
                  },
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
    { tool: "demo_read", args: { path: "local.txt" }, error: true },
    { tool: "demo_read", args: { path: "memory://other/note" }, error: true },
    { tool: "demo_copy", args: { path: "memory://demo/note", target: "local.txt" }, error: true },
    { tool: "demo_read", args: { path: "memory://demo/note" }, text: "changed\nomega" },
  ];
  assert.ok(validateRoute(task, events(calls, "direct"), "direct").passed);
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
