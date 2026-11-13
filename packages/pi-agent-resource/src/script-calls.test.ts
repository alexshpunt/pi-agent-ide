import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { trackScriptCalls } from "./script-calls.ts";

test("a call is a script's call only while it runs under a parent call of the same tool", () => {
  type Handler = (event: unknown, context: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const stub: Partial<ExtensionAPI> = {
    on: (name, handler) => {
      handlers.set(name, handler as Handler);
      return () => {
        handlers.delete(name);
      };
    },
  };
  const pi = stub as ExtensionAPI;
  const scriptCall = trackScriptCalls(pi, "search");
  const start = (toolCallId: string, toolName: string, parentToolCallId?: string) =>
    handlers.get("tool_execution_start")?.({ toolCallId, toolName, parentToolCallId }, {});

  start("nested", "search", "codemode");
  start("direct", "search");
  start("other", "read", "codemode");
  expect(["nested", "direct", "other"].map(scriptCall)).toEqual([true, false, false]);

  handlers.get("tool_execution_end")?.({ toolCallId: "nested" }, {});
  expect(scriptCall("nested")).toBe(false);
});
