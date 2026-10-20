import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { registerTerminalOrigins } from "#src/plugins/pi-agent-ide-terminal/src/origin.js";

test("captures real execution ancestry without using sibling calls or parsing IDs", () => {
  type Event = { toolCallId: string; parentToolCallId?: string };
  const handlers = new Map<string, (event: Event) => void>();
  const origin = registerTerminalOrigins({
    on: (name: string, handler: (event: Event) => void) => {
      handlers.set(name, handler);
    },
  } as ExtensionAPI);
  const context = { sessionManager: { getSessionId: () => "session-a" } } as ExtensionContext;
  const emit = (name: string, event: Event) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing ${name} handler`);
    handler(event);
  };
  emit("tool_call", { toolCallId: "outer" });
  emit("tool_call", { toolCallId: "middle", parentToolCallId: "outer" });
  emit("tool_call", { toolCallId: "opaque-leaf", parentToolCallId: "middle" });
  emit("tool_call", { toolCallId: "sibling" });
  expect(origin("opaque-leaf", context)).toEqual({
    toolCallId: "opaque-leaf",
    parentToolCallId: "outer",
    sessionId: "session-a",
  });
  expect(origin("sibling", context).parentToolCallId).toBe("sibling");
  const saved = origin("opaque-leaf", context);
  emit("tool_result", { toolCallId: "opaque-leaf" });
  emit("session_shutdown", { toolCallId: "unused" });
  expect(saved.parentToolCallId).toBe("outer");
  expect(origin("unknown/4", context).parentToolCallId).toBe("unknown/4");
});
