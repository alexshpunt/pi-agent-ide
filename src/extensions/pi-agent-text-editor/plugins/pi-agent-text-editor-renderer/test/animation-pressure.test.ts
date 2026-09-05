import { describe, expect, test, vi } from "vitest";

import {
  createMutationAnimationPressure,
  type MutationAnimationEventSource,
} from "#src/animation-pressure.js";

import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

describe("mutation animation pressure", () => {
  test("asks older mutation animations to catch up when a later tool call starts", () => {
    let messageUpdate: ((event: MessageUpdateEvent) => unknown) | undefined;
    const pi: MutationAnimationEventSource = {
      on(_event, handler) {
        messageUpdate = handler;
      },
    };
    const pressure = createMutationAnimationPressure(pi);
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = pressure.track("first", first);
    pressure.track("second", second);

    emitToolCallStart(messageUpdate, "second");
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    releaseFirst();
    emitToolCallStart(messageUpdate, "third");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});

function emitToolCallStart(
  listener: ((event: MessageUpdateEvent) => unknown) | undefined,
  toolCallId: string,
): void {
  expect(listener).toBeDefined();
  listener?.({
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: {} }],
      },
    },
  } as MessageUpdateEvent);
}
