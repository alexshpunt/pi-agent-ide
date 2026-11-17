import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { expect, test, vi } from "vitest";
import { createIdeTextResults } from "./text-results.ts";
import { textValue } from "./script-values/text.ts";

test("argument preparation uses the current schema before the tool's own preparation", () => {
  let registered: ToolDefinition | undefined;
  const stub: Partial<ExtensionAPI> = {
    events: createEventBus(),
    on: () => () => {},
    registerTool: (definition) => {
      registered = definition as ToolDefinition;
    },
  };
  const ide = createIdeTextResults(stub as ExtensionAPI);
  let schema: TSchema = Type.Object({ path: Type.String() });
  const prepareArguments = vi.fn((args: unknown) => args as Record<string, unknown>);
  ide.api.registerTool({
    name: "fixture",
    label: "fixture",
    description: "fixture",
    get parameters() {
      return schema;
    },
    prepareArguments,
    execute: async () => ({ content: [], details: {} }),
  });
  const args = { path: '["a.txt","b.txt"]' };
  expect(registered?.prepareArguments?.(args)).toEqual(args);
  schema = Type.Object({
    path: Type.Union([Type.String(), Type.Array(Type.String())]),
  });
  expect(registered?.prepareArguments?.(args)).toEqual({ path: ["a.txt", "b.txt"] });
  expect(prepareArguments.mock.calls.map(([input]) => input)).toEqual([
    args,
    { path: ["a.txt", "b.txt"] },
  ]);
});
test("a streamed refusal is checked against the original arguments before JSON decoding", () => {
  let registered: ToolDefinition | undefined;
  const events = createEventBus();
  const args = { path: '{"id":"00000000-0000-4000-8000-000000000000"}' };
  events.on("pi-agent-text-editor/guarded-argument-preparation", (value) => {
    const request = value as { arguments: unknown; refusal?: unknown };
    if (request.arguments === args)
      request.refusal = { content: [{ type: "text", text: "refusal fixture" }], details: {} };
  });
  const stub: Partial<ExtensionAPI> = {
    events,
    on: () => () => {},
    registerTool: (definition) => {
      registered = definition as ToolDefinition;
    },
  };
  const ide = createIdeTextResults(stub as ExtensionAPI);
  const prepareArguments = vi.fn((input: unknown) => input as { path: string | { id: string } });
  ide.api.registerTool({
    name: "fixture",
    label: "fixture",
    description: "fixture",
    parameters: Type.Object({
      path: Type.Union([Type.String(), Type.Object({ id: Type.String() })]),
    }),
    prepareArguments,
    execute: async () => ({ content: [], details: {} }),
  });
  expect(() => registered?.prepareArguments?.(args)).toThrow(Error);
  expect(prepareArguments).not.toHaveBeenCalled();
  expect(args.path).toBe('{"id":"00000000-0000-4000-8000-000000000000"}');
});
// Display-only batch arguments must not acquire source fields that no call supplied.
test.each(["insert", "delete", "copy", "move"])(
  "%s display preserves absent source fields",
  (name) => {
    let registered: ToolDefinition | undefined;
    const stub: Partial<ExtensionAPI> = {
      events: createEventBus(),
      on: () => () => {},
      registerTool: (definition) => {
        registered = definition as ToolDefinition;
      },
    };
    const ide = createIdeTextResults(stub as ExtensionAPI);
    const renderCall = vi.fn((_args: unknown) => ({ render: () => [], invalidate: () => {} }));
    ide.api.registerTool({
      name,
      label: name,
      description: "fixture",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
      renderCall,
    });
    const args = { text: "fixture" };
    if (!registered?.renderCall) throw new Error("No call renderer");
    registered.renderCall(args, undefined as never, undefined as never);
    expect(renderCall.mock.calls[0]?.[0]).toStrictEqual(args);
    expect(args).toEqual({ text: "fixture" });
  },
);

test("a throwing projection returns null and reports the failure without exposing the private record", async () => {
  type Handler = (event: unknown, context: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const stub: Partial<ExtensionAPI> = {
    events: createEventBus(),
    on: (name, handler) => {
      handlers.set(name, handler as Handler);
      return () => {};
    },
    registerTool: () => {},
  };
  const pi = stub as ExtensionAPI;
  const ide = createIdeTextResults(pi);
  ide.api.registerTool({
    name: "fixture",
    label: "fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  } as ToolDefinition);
  ide.finalize();
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, { cwd: "/workspace" });
  const projectionError = "projection fixture failure";
  const spy = vi.spyOn(textValue, "project").mockImplementation(() => {
    throw new Error(projectionError);
  });
  try {
    emit("tool_execution_start", { toolCallId: "child", parentToolCallId: "parent" });
    const privateRecord = { status: "success", data: { secret: "private fixture" } };
    const result = await emit("tool_result", {
      toolName: "fixture",
      toolCallId: "child",
      content: [{ type: "text", text: "private fixture" }],
      structuredContent: privateRecord,
      details: {},
      isError: false,
    });
    const hookResult = result as { content: unknown; structuredContent?: unknown };
    const merged = {
      content: hookResult.content,
      structuredContent: hookResult.structuredContent ?? privateRecord,
    };
    emit("tool_execution_end", { toolCallId: "child", result: merged });
    expect(merged.structuredContent).toBeNull();
    expect(JSON.stringify(merged)).not.toContain("private fixture");
    const outer = await emit("tool_result", {
      toolName: "codemode",
      toolCallId: "parent",
      content: [],
      details: {},
    });
    expect(JSON.stringify(outer)).toContain(projectionError);
    expect(JSON.stringify(outer)).not.toContain("private fixture");
    const direct = await emit("tool_result", {
      toolName: "fixture",
      toolCallId: "direct",
      content: [
        { type: "text", text: "direct output" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      structuredContent: privateRecord,
      details: {},
      isError: false,
    });
    // No hook modification: Pi retains all original direct-call content, including images.
    expect(direct).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});
