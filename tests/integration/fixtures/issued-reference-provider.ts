import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IssuedArgumentStream } from "../../support/issued-argument-stream.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";

/** Put references from real prior tool results into the scripted provider stream, before IDE hooks. */
export default function issuedReferenceProvider(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    const model = context.model;
    if (!model || model.provider !== "scripted") return;
    const provider = context.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("Missing scripted provider");
    const delegate = provider.streamSimple.bind(provider);
    pi.registerProvider(model.provider, {
      ...context.modelRegistry.getRegisteredProviderConfig(model.provider),
      api: model.api,
      streamSimple(currentModel, transcript, options) {
        const output = createAssistantMessageEventStream();
        let partial: AssistantMessage = {
          role: "assistant",
          content: [],
          api: currentModel.api,
          provider: currentModel.provider,
          model: currentModel.id,
          stopReason: "toolUse",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const reference = (_token: string, kind: string, id: string, line?: string): string => {
          const result = transcript.messages.findLast(
            (message) => message.role === "toolResult" && message.toolCallId === id,
          );
          if (!result || result.role !== "toolResult")
            throw new Error(`Missing prior result ${id}`);
          const shown = result.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          if (kind === "result") return JSON.stringify(shown).slice(1, -1);
          if (kind === "anchor") {
            const anchors = [...shown.matchAll(/(?:^|\n)\s*([A-Z\d]{7})\|/gu)];
            const value = anchors[Number(line) - 1]?.[1];
            if (!value) throw new Error(`Missing ${kind} reference in ${id}`);
            return value;
          }
          const expression =
            kind === "uuid"
              ? /<uuid>([^<]+)<\/uuid>/u
              : kind === "item"
                ? /(RESULT#[a-f\d-]{36})/u
                : kind === "search"
                  ? new RegExp(`(SEARCH#[A-F\\d]+:${line ?? "\\d+"}:line)`, "u")
                  : kind === "searchmatch"
                    ? new RegExp(`(SEARCH#[A-F\\d]+:${line ?? "\\d+"}:match)`, "u")
                    : kind === "searchallline"
                      ? /(SEARCH#[A-F\d]+:all:line)/u
                      : kind === "searchallmatch"
                        ? /(SEARCH#[A-F\d]+:all:match)/u
                        : /(SEARCH#[A-F\d]+):/u;
          const value = expression.exec(shown)?.[1];
          if (!value) throw new Error(`Missing ${kind} reference in ${id}`);
          return value;
        };
        const pattern =
          /\$issued-(uuid|result|item|search(?:match|allline|allmatch|id)?|anchor):([a-z][a-z\d-]*)(?::(\d+))?/gu;
        const argumentsByIndex = new Map<number, IssuedArgumentStream>();
        const forward = (event: AssistantMessageEvent, delta?: string): void => {
          // Snapshots may contain an unfinished ID. Rebuild their arguments from the safe stream.
          const forwarded = JSON.parse(
            JSON.stringify(event, (key, value) =>
              key === "arguments"
                ? {}
                : key === "delta" && event.type === "toolcall_delta"
                  ? ""
                  : value,
            ).replace(pattern, reference),
          ) as AssistantMessageEvent;
          const message =
            forwarded.type === "done"
              ? forwarded.message
              : forwarded.type === "error"
                ? forwarded.error
                : forwarded.partial;
          for (const [index, block] of message.content.entries()) {
            if (block.type === "toolCall")
              block.arguments = argumentsByIndex.get(index)?.arguments ?? {};
          }
          if (forwarded.type === "toolcall_delta") forwarded.delta = delta ?? "";
          if (forwarded.type === "toolcall_end")
            forwarded.toolCall.arguments =
              argumentsByIndex.get(forwarded.contentIndex)?.arguments ?? {};
          partial = message;
          output.push(forwarded);
        };
        void (async () => {
          try {
            for await (const event of delegate(currentModel, transcript, options)) {
              if (event.type === "toolcall_start")
                argumentsByIndex.set(
                  event.contentIndex,
                  new IssuedArgumentStream((value) => value.replace(pattern, reference)),
                );
              if (event.type === "toolcall_delta") {
                const stream = argumentsByIndex.get(event.contentIndex);
                if (!stream) throw new Error(`Missing argument stream ${event.contentIndex}`);
                const delta = stream.push(event.delta);
                if (delta) forward(event, delta);
                continue;
              }
              if (event.type === "toolcall_end" || event.type === "done") {
                for (const [contentIndex, stream] of argumentsByIndex) {
                  if (event.type === "toolcall_end" && contentIndex !== event.contentIndex)
                    continue;
                  const delta = stream.push("", true);
                  if (delta)
                    forward(
                      {
                        type: "toolcall_delta",
                        contentIndex,
                        delta,
                        partial: event.type === "done" ? event.message : event.partial,
                      },
                      delta,
                    );
                }
              }
              forward(event);
            }
          } catch (error) {
            output.push({
              type: "error",
              reason: "error",
              error: {
                ...partial,
                stopReason: "error",
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            });
          } finally {
            output.end();
          }
        })();
        return output;
      },
    });
  });
}
