import { describe, expect, test } from "vitest";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const start = (
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
  parentToolCallId?: string,
): RunEvent => ({ type: "tool_execution_start", toolCallId: id, toolName, args, parentToolCallId });
const end = (id: string, text = "done", isError = false): RunEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  isError,
  result: { content: [{ type: "text", text }] },
});
const message = (...ids: string[]): RunEvent => ({
  type: "message_end",
  message: { role: "assistant", content: ids.map((id) => ({ type: "toolCall", id })) },
});

const together = { steps: [{ tool: "copy" }, { tool: "copy", sameAssistantWith: 0 }] };
const parent = start("script", "codemode");
const first = start("first", "copy", {}, "script");
const second = start("second", "copy", {}, "script");

describe("sameAssistantWith execution evidence", () => {
  test("accepts overlapping native children, irrespective of completion order", () => {
    for (const completions of [
      [end("first"), end("second")],
      [end("second"), end("first")],
    ])
      expect(validateRoute(together, [parent, first, second, ...completions], "codemode")).toEqual({
        passed: true,
        reasons: [],
      });
  });

  test.each([
    [parent, first, end("first"), second, end("second")],
    [
      parent,
      start("other", "codemode"),
      first,
      { ...second, parentToolCallId: "other" },
      end("first"),
      end("second"),
    ],
    [parent, first, second, end("first"), end("second", "failed", true)],
    [parent, first, second, end("first")],
    [first, second, end("first"), end("second")],
  ])("rejects sequential, separate-parent, failed or unissued children (%#)", (...events) => {
    expect(validateRoute(together, events, "codemode").passed).toBe(false);
  });

  test("direct calls still require one completed assistant message", () => {
    const calls = [start("first", "copy"), end("first"), start("second", "copy"), end("second")];
    expect(validateRoute(together, [message("first", "second"), ...calls], "direct").passed).toBe(
      true,
    );
    expect(
      validateRoute(together, [message("first"), message("second"), ...calls], "direct").passed,
    ).toBe(false);
    expect(validateRoute(together, calls, "direct").passed).toBe(false);
  });
});

test("concurrent transfer equivalence retains selectors, required calls and result reuse", () => {
  const id = "RESULT#9b901a2b-a965-4729-8abb-3c09c3cbc6c2";
  const route = {
    files: { "source.txt": "COPY\n" },
    steps: [
      { tool: "read", args: { path: "source.txt" } },
      {
        tool: "copy",
        args: { path: "source.txt", start: "COPY", target: "first.txt" },
        reuse: { from: 0, field: "path" },
      },
      {
        tool: "copy",
        args: { path: "source.txt", start: "COPY", target: "second.txt" },
        sameAssistantWith: 1,
      },
    ],
  };
  const events = [
    parent,
    start("read", "read", { path: "source.txt" }, "script"),
    end("read", `<uuid>${id.slice(7)}</uuid>\nCOPY`),
    start("first", "copy", { path: { id }, start: "COPY", target: "first.txt" }, "script"),
    start("second", "copy", { path: "source.txt", start: "COPY", target: "second.txt" }, "script"),
    end("first"),
    end("second"),
  ];
  expect(validateRoute(route, events, "codemode").passed).toBe(true);
  for (const args of [
    { path: "source.txt", start: "COPY", target: "first.txt" },
    { path: { id }, start: "OTHER", target: "first.txt" },
  ]) {
    const changed = events.map((event) =>
      event.toolCallId === "first" && event.type === "tool_execution_start"
        ? { ...event, args }
        : event,
    );
    expect(validateRoute(route, changed, "codemode").passed).toBe(false);
  }
  expect(
    validateRoute(
      route,
      events.filter((event) => event.toolCallId !== "second"),
      "codemode",
    ).passed,
  ).toBe(false);
});
const hash = "D07BBXQ";
const read = (path = "task.txt", text = `${hash}|OLD`) => [
  start("read", "read", { path, views: ["anchors"] }),
  end("read", text),
];
const replace = (args: Record<string, unknown>) => [
  start("replace", "replace", args),
  end("replace"),
];
const replacement = { tool: "replace", args: { newText: "NEW" } };

describe("issued whole-line replacement equivalence", () => {
  test.each(["\n", "\r\n"])(
    "requires the line's separator exactly as the case spells it on a %j line",
    (eol) => {
      // Replace writes its text as sent: a replacement without the separator joins the next line.
      const files = { "task.txt": `keep${eol}OLD${eol}last${eol}` };
      const kept = { tool: "replace", args: { newText: `NEW${eol}` } };
      for (const selector of [hash, `${hash}|OLD`, `${hash}|OLD${eol}`]) {
        expect(
          validateRoute(
            { files, steps: [kept] },
            [...read(), ...replace({ path: "task.txt", start: selector, newText: `NEW${eol}` })],
            "direct",
          ),
        ).toEqual({ passed: true, reasons: [] });
        for (const [steps, text] of [
          [[replacement], `NEW${eol}`],
          [[kept], "NEW"],
        ] as const)
          expect(
            validateRoute(
              { files, steps: [...steps] },
              [...read(), ...replace({ path: "task.txt", start: selector, newText: text })],
              "direct",
            ).passed,
          ).toBe(false);
      }
    },
  );

  test("preserves exact arguments without fixture evidence", () => {
    expect(
      validateRoute(
        { steps: [replacement] },
        replace({ path: "task.txt", start: hash, newText: "NEW" }),
        "direct",
      ).passed,
    ).toBe(true);
  });

  test.each<{
    files: Record<string, string>;
    issued: RunEvent[];
    args: Record<string, unknown>;
  }>([
    {
      files: { "task.txt": "keep\nOLD" },
      issued: read(),
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "left OLD right\n" },
      issued: read(),
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: [],
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n", "other.txt": "OLD\n" },
      issued: read("other.txt"),
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: [start("read", "read", { path: "task.txt" }), end("read", `${hash}|OLD`, true)],
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: read(),
      args: { path: "task.txt", start: "D07BBXR", newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: read(),
      args: { path: "task.txt", start: `${hash}|OTHER`, text: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: read(),
      args: { path: "task.txt", start: hash, newText: "NEW\n\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: [
        ...read(),
        start("edit", "write", { path: "task.txt", content: "OLD\n" }),
        end("edit"),
      ],
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
    {
      files: { "task.txt": "OLD\n" },
      issued: [...read(), start("edit", "write", { path: "task.txt", content: "OLD\n" })],
      args: { path: "task.txt", start: hash, newText: "NEW\n" },
    },
  ])("does not invent whole-line or fresh-snapshot authority (%#)", ({ files, issued, args }) => {
    expect(
      validateRoute({ files, steps: [replacement] }, [...issued, ...replace(args)], "direct")
        .passed,
    ).toBe(false);
  });
});

describe("Read view requirements", () => {
  const check = (actual: unknown, expected: unknown = ["anchors"], tool = "read") =>
    validateRoute(
      { steps: [{ tool, args: { path: "task.txt", views: expected } }] },
      [start("call", tool, { path: "task.txt", views: actual }), end("call")],
      "direct",
    ).passed;

  test("requires each requested view, allowing additional views and any order", () => {
    expect(check(["ast", "anchors", "diagnostics"])).toBe(true);
    expect(check(["diagnostics", "anchors"], ["anchors", "diagnostics"])).toBe(true);
    expect(check(["anchors", "ast"])).toBe(true);
  });
  test("keeps missing and different parameterized views strict", () => {
    expect(check(["ast", "diagnostics"])).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(check(["anchors"], ["anchors", "diagnostics"])).toBe(false);
    expect(check(["image:scale=0.5"], ["image:scale=1"])).toBe(false);
  });
  test("does not relax other tools' argument arrays or script results", () => {
    expect(check(["ast", "anchors"], ["anchors"], "search")).toBe(false);
    expect(
      validateRoute(
        { steps: [{ tool: "read", scriptResult: { views: ["anchors", "ast"] } }] },
        [
          start("call", "read"),
          { ...end("call"), result: { structuredContent: { views: ["ast", "anchors"] } } },
        ],
        "direct",
      ).passed,
    ).toBe(false);
  });
});
