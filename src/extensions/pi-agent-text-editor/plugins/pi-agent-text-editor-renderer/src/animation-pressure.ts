import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

export const NEXT_TOOL_CALL_DRAIN_MS = 300;

/** Pi event surface used to detect when model output has moved to another tool call. */
export interface MutationAnimationEventSource {
  on(event: "message_update", handler: (event: MessageUpdateEvent) => unknown): unknown;
}

/** Coordinates mutation animations with later tool calls in the model stream. */
export interface MutationAnimationPressure {
  /** Track one active mutation animation until the returned release function is called. */
  track(toolCallId: string, catchUp: () => void): () => void;
}

/** Create the session-level pressure signal shared by mutation renderers. */
export function createMutationAnimationPressure(
  pi: MutationAnimationEventSource,
): MutationAnimationPressure {
  const active = new Map<string, () => void>();

  pi.on("message_update", (event) => {
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "toolcall_start") {
      return;
    }

    const block = streamEvent.partial.content[streamEvent.contentIndex];
    if (block?.type !== "toolCall") {
      return;
    }

    for (const [toolCallId, catchUp] of active) {
      if (toolCallId !== block.id) {
        catchUp();
      }
    }
  });

  return {
    track(toolCallId, catchUp) {
      active.set(toolCallId, catchUp);
      return () => {
        if (active.get(toolCallId) === catchUp) {
          active.delete(toolCallId);
        }
      };
    },
  };
}
