import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createNestedIdeRendering } from "./nested-tool-rendering.js";

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
  }[];
}
const retained: Retention = {
  argumentsTruncated: false,
  resultsOmitted: false,
  callsOmitted: false,
  resultsUnavailable: false,
};

function display() {
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
    registerEntryRenderer: () => {},
    appendEntry: (_name, data) => {
      saved = data as SavedGroup;
    },
  };
  const rendering = createNestedIdeRendering(stub as ExtensionAPI);
  rendering.api.registerTool({
    name: "write",
    label: "write",
    description: "fixture",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  } as ToolDefinition);
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, { cwd: "/workspace" });
  const start = (id: string, args: unknown = {}) =>
    emit("tool_execution_start", {
      parentToolCallId: "parent",
      toolCallId: id,
      toolName: "write",
      args,
    });
  const end = (id: string, text = "saved", isError = false, details?: unknown) =>
    emit("tool_execution_end", {
      toolCallId: id,
      result: { content: [{ type: "text", text }], details },
      isError,
    });
  const finish = () => {
    emit("message_end", { message: { role: "toolResult", toolCallId: "parent" } });
    if (!saved) throw new Error("No saved panels");
    return JSON.parse(JSON.stringify(saved)) as SavedGroup;
  };
  return { start, end, finish };
}

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

test.each(["oversize", "unsupported"])("%s results keep an honest bounded fallback", (kind) => {
  const run = display();
  run.start("result");
  const circular: { self?: unknown } = {};
  circular.self = circular;
  run.end(
    "result",
    kind === "oversize" ? "x".repeat(600 * 1024) : "done",
    true,
    kind === "unsupported" ? circular : { fullOutputPath: "/tmp/full-output" },
  );
  const saved = run.finish();
  expect(saved.retention).toEqual({ ...retained, resultsOmitted: true });
  expect(saved.calls[0]?.result?.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(512 * 1024);
  if (kind === "oversize") expect(JSON.stringify(saved)).toContain("/tmp/full-output");
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
