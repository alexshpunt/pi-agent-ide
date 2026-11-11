import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createNestedIdeRendering, formatToolDuration } from "./nested-tool-rendering.ts";

interface Retention {
  argumentsTruncated: boolean;
  resultsOmitted: boolean;
  callsOmitted: boolean;
  resultsUnavailable: boolean;
}
interface SavedGroup {
  retention: Retention;
  calls: {
    args: unknown;
    argumentsTruncated?: boolean;
    resultOmitted?: boolean;
    result?: { isError: boolean };
    durationMs?: number;
  }[];
}
const retained: Retention = {
  argumentsTruncated: false,
  resultsOmitted: false,
  callsOmitted: false,
  resultsUnavailable: false,
};

function display(toolName = "write") {
  type Handler = (event: unknown, context: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  let saved: SavedGroup | undefined;
  const stub: Partial<ExtensionAPI> = {
    on: (name, handler) => {
      handlers.set(name, handler as Handler);
      return () => {
        handlers.delete(name);
      };
    },
    registerTool: () => {},
    registerToolRenderer: () => {},
    getAllTools: () => [],
    registerEntryRenderer: () => {},
    appendEntry: (_name, data) => {
      saved = data as SavedGroup;
    },
  };
  const rendering = createNestedIdeRendering(stub as ExtensionAPI);
  rendering.api.registerTool({
    name: toolName,
    label: toolName,
    description: "fixture",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  } as ToolDefinition);
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, { cwd: "/workspace" });
  const start = (id: string, args: unknown = {}) =>
    emit("tool_execution_start", {
      parentToolCallId: "parent",
      toolCallId: id,
      toolName,
      args,
    });
  const end = (
    id: string,
    text = "saved",
    isError = false,
    details?: unknown,
    durationMs?: number,
  ) =>
    emit("tool_execution_end", {
      toolCallId: id,
      result: { content: [{ type: "text", text }], details },
      isError,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  const finish = () => {
    emit("message_end", { message: { role: "toolResult", toolCallId: "parent" } });
    if (!saved) throw new Error("No saved panels");
    return JSON.parse(JSON.stringify(saved)) as SavedGroup;
  };
  return { start, end, finish };
}

test("each child keeps its own recorded duration and a missing one stays absent", () => {
  const run = display();
  run.start("slow");
  run.start("fast");
  run.start("unknown");
  run.end("fast", "saved", false, undefined, 120);
  run.end("slow", "saved", false, undefined, 1_480);
  run.end("unknown");
  const saved = run.finish();
  expect(saved.calls.map((call) => call.durationMs)).toEqual([1_480, 120, undefined]);
  expect(saved.calls[2]).not.toHaveProperty("durationMs");
});

test.each([
  [0, "0.0s"],
  [4_249, "4.2s"],
  [90_000, "1m 30s"],
  [7_384_000, "2h 3m 4s"],
])("formats %i ms like native tool rows", (ms, label) => {
  expect(formatToolDuration(ms)).toBe(label);
});

test("large arguments do not mark retained results as omitted", () => {
  const run = display();
  run.start("write", { path: "large.txt", content: "x".repeat(10_000) });
  run.end("write");
  const saved = run.finish();
  expect(saved.retention).toEqual({ ...retained, argumentsTruncated: true });
  expect(saved.calls[0]?.result).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(saved.calls[0]?.args))).toBeLessThanOrEqual(8 * 1024);
});

test("wide argument objects cannot exceed the per-call preview budget", () => {
  const run = display();
  run.start(
    "wide",
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), "x".repeat(300)])),
  );
  run.end("wide");
  const saved = run.finish();
  expect(saved.retention).toEqual({ ...retained, argumentsTruncated: true });
  expect(Buffer.byteLength(JSON.stringify(saved.calls[0]?.args))).toBeLessThanOrEqual(8 * 1024);
});

test("a retained tool error is not a display-retention failure", () => {
  const run = display();
  run.start("failed");
  run.end("failed", "not applied", true);
  const saved = run.finish();
  expect(saved.retention).toEqual(retained);
  expect(saved.calls[0]?.result?.isError).toBe(true);
});

test("calls with no end event are marked unavailable rather than omitted", () => {
  const run = display();
  run.start("partial");
  expect(run.finish().retention).toEqual({ ...retained, resultsUnavailable: true });
});

test("the call cap records missing panels without claiming missing results in kept calls", () => {
  const run = display();
  for (let i = 0; i < 260; i++) {
    run.start(String(i));
    run.end(String(i));
  }
  const saved = run.finish();
  expect(saved.calls).toHaveLength(256);
  expect(saved.retention).toEqual({ ...retained, callsOmitted: true });
});

test("unsupported results keep an honest bounded fallback", () => {
  const run = display();
  run.start("result");
  const circular: { self?: unknown } = {};
  circular.self = circular;
  run.end("result", "done", true, circular);
  const saved = run.finish();
  expect(saved.retention).toEqual({ ...retained, resultsOmitted: true });
  expect(saved.calls[0]?.result?.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
});

test.each([
  { name: "one long line", text: "x".repeat(600 * 1024), shown: 0 },
  {
    name: "many lines",
    text: Array.from({ length: 40_000 }, (_, index) => `row ${index}`).join("\n"),
    shown: 2000,
  },
  {
    name: "composition reference",
    text:
      ["<system-", 'result note="Internal reference"><uuid>', "0".repeat(8), "-0000-0000-0000-"]
        .concat("0".repeat(12), "</uuid></system-", "result>\n")
        .join("") + Array.from({ length: 40_000 }, (_, index) => `row ${index}`).join("\n"),
    shown: 2000,
  },
])(
  "an oversized Read result shows its head instead of being omitted ($name)",
  ({ text, shown }) => {
    const run = display("read");
    run.start("result");
    run.end("result", text, false, {
      fullOutputPath: "/tmp/full-output",
      storedLines: Array.from({ length: 40_000 }, (_, index) => [index + 1, [0, 1], "\n"]),
    });
    const saved = run.finish();
    expect(saved.retention).toEqual(retained);
    const result = saved.calls[0]?.result as
      | { content: { text: string }[]; details: Record<string, unknown> }
      | undefined;
    const block = result?.content[0]?.text ?? "";
    expect(block.endsWith("the calling tool received the whole result.]")).toBe(true);
    expect(block).toContain(`[Showing ${shown} of ${shown > 0 ? "40000" : "1"} lines`);
    const reference = text.startsWith("<system-result") ? `${text.split("\n")[0]}\n` : "";
    if (shown > 0) expect(block.startsWith(`${reference}row 0\nrow 1\n`)).toBe(true);
    expect(result?.details).toEqual({ fullOutputPath: "/tmp/full-output" });
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
  },
);

test("other oversized results stay omitted because their renderers need full details", () => {
  const run = display();
  run.start("result");
  run.end("result", "x".repeat(600 * 1024), true, { fullOutputPath: "/tmp/full-output" });
  const saved = run.finish();
  expect(saved.retention).toEqual({ ...retained, resultsOmitted: true });
  expect(saved.calls[0]?.result?.isError).toBe(true);
  expect(JSON.stringify(saved)).toContain("/tmp/full-output");
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
});

test("argument and saved group budgets hold across many retained calls", () => {
  const run = display();
  for (let i = 0; i < 256; i++) {
    run.start(String(i), { path: "large.txt", content: "🙂".repeat(1_500) });
    run.end(String(i), "result".repeat(1_000));
  }
  const saved = run.finish();
  expect(saved.retention.argumentsTruncated).toBe(true);
  expect(saved.retention.resultsOmitted).toBe(true);
  expect(saved.retention.resultsUnavailable).toBe(false);
  expect(
    saved.calls.reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify(call.args)), 0),
  ).toBeLessThanOrEqual(32 * 1024);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
});
