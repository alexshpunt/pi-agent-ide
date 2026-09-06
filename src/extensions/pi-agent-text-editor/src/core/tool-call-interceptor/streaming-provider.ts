import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { GuardInterception } from "./coordinator.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const streamingInterceptorState = Symbol.for(
  "pi-agent-text-editor.tool-call-interceptor.streaming-provider.state",
);

type ProcessStreamEvent = (
  event: AssistantMessageEvent,
  context: ExtensionContext,
) => Promise<GuardInterception | undefined>;
type MarkStreamEventProcessed = (event: AssistantMessageEvent) => void;
type FinalizeStreamInterception = (contentIndex: number) => void;

interface StreamingSubscriber {
  context: ExtensionContext | undefined;
  readonly processStreamEvent: ProcessStreamEvent;
  readonly markStreamEventProcessed: MarkStreamEventProcessed;
  readonly finalizeStreamInterception: FinalizeStreamInterception;
}

interface SharedProviderState {
  api: string;
  readonly delegate: StreamSimple;
  readonly wrapper: WrappedStreamSimple;
  readonly subscribers: Set<StreamingSubscriber>;
}

type WrappedStreamSimple = StreamSimple & { [streamingInterceptorState]?: SharedProviderState };

/**
Install one shared stream wrapper for all interceptors using each active provider.
*/
export function registerStreamingInterceptorProvider(
  pi: ExtensionAPI,
  processStreamEvent: ProcessStreamEvent,
  markStreamEventProcessed: MarkStreamEventProcessed,
  finalizeStreamInterception: FinalizeStreamInterception,
): void {
  const installed = new Map<string, SharedProviderState>();
  const subscriber: StreamingSubscriber = {
    context: undefined,
    processStreamEvent,
    markStreamEventProcessed,
    finalizeStreamInterception,
  };

  const install = (model: Model<Api> | undefined, context: ExtensionContext): void => {
    if (!model) {
      return;
    }

    const provider = context.modelRegistry.getProvider(model.provider);

    if (!provider) {
      return;
    }

    const active = installed.get(model.provider);

    if (active) {
      active.subscribers.add(subscriber);

      if (active.api === model.api && provider.streamSimple === active.wrapper) {
        return;
      }

      active.api = model.api;
      const config = context.modelRegistry.getRegisteredProviderConfig(model.provider);
      pi.registerProvider(model.provider, {
        ...config,
        api: model.api,
        streamSimple: active.wrapper,
      });
      return;
    }

    const shared = (provider.streamSimple as WrappedStreamSimple)[streamingInterceptorState];

    if (shared) {
      shared.subscribers.add(subscriber);
      installed.set(model.provider, shared);

      if (shared.api === model.api) {
        return;
      }

      shared.api = model.api;
      const config = context.modelRegistry.getRegisteredProviderConfig(model.provider);
      pi.registerProvider(model.provider, {
        ...config,
        api: model.api,
        streamSimple: shared.wrapper,
      });
      return;
    }

    const delegate = provider.streamSimple.bind(provider);
    const subscribers = new Set([subscriber]);
    const wrapper: WrappedStreamSimple = (currentModel, context, options) =>
      wrapStream(delegate, currentModel, context, options, subscribers);
    const state: SharedProviderState = {
      api: model.api,
      delegate,
      wrapper,
      subscribers,
    };
    wrapper[streamingInterceptorState] = state;
    const config = context.modelRegistry.getRegisteredProviderConfig(model.provider);

    pi.registerProvider(model.provider, {
      ...config,
      api: model.api,
      streamSimple: wrapper,
    });
    installed.set(model.provider, state);
  };

  pi.on("before_provider_request", (_event, context) => {
    subscriber.context = context;
    install(context.model, context);
  });

  pi.on("turn_start", (_event, context) => {
    subscriber.context = context;
    install(context.model, context);
  });

  pi.on("agent_start", (_event, context) => {
    subscriber.context = context;
    install(context.model, context);
  });
  pi.on("session_start", (_event, context) => {
    subscriber.context = context;
    install(context.model, context);
  });

  pi.on("model_select", (event, context) => {
    subscriber.context = context;
    install(event.model, context);
  });

  pi.on("session_shutdown", () => {
    for (const [provider, state] of installed) {
      state.subscribers.delete(subscriber);

      if (state.subscribers.size === 0) {
        pi.unregisterProvider(provider);
      }
    }

    installed.clear();
    subscriber.context = undefined;
  });
}

function wrapStream(
  delegate: StreamSimple,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  subscribers: ReadonlySet<StreamingSubscriber>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const providerController = new AbortController();
  const parentSignal = options?.signal;
  let isIntercepted = false;
  let frozenPartial = emptyAssistantMessage(model);
  const startedContent = new Set<number>();
  const endedText = new Set<number>();
  const endedThinking = new Set<number>();
  const endedToolCalls = new Set<number>();
  const markStreamEventProcessed = (event: AssistantMessageEvent): void => {
    for (const subscriber of subscribers) {
      subscriber.markStreamEventProcessed(event);
    }
  };

  const abortFromParent = (): void => {
    providerController.abort();
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      providerController.abort();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  void (async () => {
    try {
      const upstream = delegate(model, context, { ...options, signal: providerController.signal });

      for await (const event of upstream) {
        if (isIntercepted) {
          continue;
        }

        if (event.type === "done") {
          frozenPartial = structuredClone(event.message);
        } else if (event.type === "error") {
          frozenPartial = structuredClone(event.error);
        } else {
          frozenPartial = structuredClone(event.partial);
        }

        rememberStartEvent(event, startedContent);

        let interception: GuardInterception | undefined;

        for (const subscriber of subscribers) {
          const extensionContext = subscriber.context;

          if (extensionContext) {
            const result = await subscriber.processStreamEvent(event, extensionContext);
            interception ??= result;
          }
        }

        markStreamEventProcessed(event);

        rememberEndEvent(event, endedText, endedThinking, endedToolCalls);
        output.push(structuredClone(event));

        if (interception) {
          if (event.type === "toolcall_delta" || event.type === "toolcall_end") {
            for (const subscriber of subscribers) {
              subscriber.finalizeStreamInterception(event.contentIndex);
            }
          }

          isIntercepted = true;
          providerController.abort();

          const interceptedContentIndex =
            event.type === "toolcall_delta" || event.type === "toolcall_end"
              ? event.contentIndex
              : undefined;
          const partial: AssistantMessage = {
            ...frozenPartial,
            content: frozenPartial.content
              .filter(
                (_block, contentIndex) =>
                  startedContent.has(contentIndex) &&
                  (interceptedContentIndex === undefined ||
                    contentIndex <= interceptedContentIndex ||
                    endedToolCalls.has(contentIndex)),
              )
              .map((block) =>
                block.type === "toolCall" && block.id === interception.toolCallId
                  ? { ...block, arguments: structuredClone(interception.arguments) }
                  : block,
              ),
          };
          emitMissingEndEvents(
            output,
            markStreamEventProcessed,
            partial,
            startedContent,
            endedText,
            endedThinking,
            endedToolCalls,
          );
          const { errorMessage: _errorMessage, ...withoutErrorMessage } = partial;
          output.push({
            type: "done",
            reason: "toolUse",
            message: {
              ...withoutErrorMessage,
              stopReason: "toolUse",
            },
          });
          output.end();
          continue;
        }

        if (event.type === "done" || event.type === "error") {
          output.end();
          return;
        }
      }
    } catch (error) {
      if (isIntercepted) {
        return;
      }

      const partial = frozenPartial;
      const reason: "aborted" | "error" = parentSignal?.aborted === true ? "aborted" : "error";
      const message: AssistantMessage = {
        ...partial,
        stopReason: reason,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      output.push({ type: "error", reason, error: message });
      output.end();
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  })();

  return output;
}

function rememberStartEvent(event: AssistantMessageEvent, startedContent: Set<number>): void {
  if (
    event.type === "text_start" ||
    event.type === "thinking_start" ||
    event.type === "toolcall_start"
  ) {
    startedContent.add(event.contentIndex);
  }
}

function rememberEndEvent(
  event: AssistantMessageEvent,
  endedText: Set<number>,
  endedThinking: Set<number>,
  endedToolCalls: Set<number>,
): void {
  switch (event.type) {
    case "text_end": {
      endedText.add(event.contentIndex);
      break;
    }
    case "thinking_end": {
      endedThinking.add(event.contentIndex);
      break;
    }
    case "toolcall_end": {
      endedToolCalls.add(event.contentIndex);
      break;
    }
  }
}

function emitMissingEndEvents(
  output: AssistantMessageEventStream,
  markStreamEventProcessed: MarkStreamEventProcessed,
  partial: AssistantMessage,
  startedContent: ReadonlySet<number>,
  endedText: ReadonlySet<number>,
  endedThinking: ReadonlySet<number>,
  endedToolCalls: ReadonlySet<number>,
): void {
  for (const [contentIndex, block] of partial.content.entries()) {
    if (!startedContent.has(contentIndex)) {
      continue;
    }

    if (block.type === "text" && !endedText.has(contentIndex)) {
      const event: AssistantMessageEvent = {
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      };
      markStreamEventProcessed(event);
      output.push(event);
    } else if (block.type === "thinking" && !endedThinking.has(contentIndex)) {
      const event: AssistantMessageEvent = {
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial,
      };
      markStreamEventProcessed(event);
      output.push(event);
    } else if (block.type === "toolCall" && !endedToolCalls.has(contentIndex)) {
      const event: AssistantMessageEvent = {
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial,
      };
      markStreamEventProcessed(event);
      output.push(event);
    }
  }
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
