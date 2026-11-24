import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordExtensionApiWrapper } from "pi-problem-report/api-identity";
import { describe, expect, test } from "vitest";

import {
  processToolCallStreamEvent,
  registerToolCallInterceptor,
} from "#src/core/tool-call-interceptor/coordinator.ts";

/** A Pi runtime plus two module wrappers around it, as the Agent IDE composite creates. */
function runtimeWithModules() {
  const host: Pick<ExtensionAPI, "on" | "events" | "registerProvider" | "unregisterProvider"> = {
    on: () => () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    registerProvider: () => undefined,
    unregisterProvider: () => undefined,
  };
  const runtime = host as ExtensionAPI;
  const module = (): ExtensionAPI => {
    const wrapper = { ...runtime };
    recordExtensionApiWrapper(wrapper, runtime);
    return wrapper;
  };
  return { core: module(), plugin: module() };
}

describe("tool-call interceptor coordinator", () => {
  test("an interceptor registered by one module intercepts calls streamed through another", async () => {
    const { core, plugin } = runtimeWithModules();
    registerToolCallInterceptor(plugin, {
      name: "stale-anchor",
      toolNames: ["replace"],
      intercept: () => ({
        message: { customType: "blocked", content: "Anchor is stale.", display: false },
      }),
    });

    const partial: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "replace", arguments: {} }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const extensionContext: Pick<ExtensionContext, "cwd" | "signal"> = {
      cwd: "/tmp",
      signal: undefined,
    };
    const context = extensionContext as ExtensionContext;
    await processToolCallStreamEvent(
      core,
      { type: "toolcall_start", contentIndex: 0, partial },
      context,
    );
    const interception = await processToolCallStreamEvent(
      core,
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts","text":"x"}', partial },
      context,
    );

    expect(interception?.toolCallId).toBe("call-1");
  });
});
