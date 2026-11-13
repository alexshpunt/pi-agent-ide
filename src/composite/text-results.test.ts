import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createIdeTextResults } from "./text-results.ts";
import { textValue } from "./script-values/text.ts";

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
