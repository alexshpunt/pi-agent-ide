import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
          if (!result || result.role !== "toolResult") throw new Error(`Missing prior result ${id}`);
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
        const pattern = /\$issued-(uuid|result|item|search(?:match|allline|allmatch|id)?|anchor):([a-z][a-z\d-]*)(?::(\d+))?/gu;
        // This fixture resolves references, not streaming timing. Wait for complete arguments so
        // neither split tokens nor the delegate's partial argument snapshots can resolve an ID early.
        const argumentsByIndex = new Map<number, string>();
        void (async () => {
          try {
            for await (const event of delegate(currentModel, transcript, options)) {
              if (event.type === "toolcall_delta") {
                argumentsByIndex.set(
                  event.contentIndex,
                  (argumentsByIndex.get(event.contentIndex) ?? "") + event.delta,
                );
                continue;
              }
              const forwarded = JSON.parse(
                JSON.stringify(event).replace(pattern, reference),
              ) as AssistantMessageEvent;
              if (forwarded.type === "toolcall_end" || forwarded.type === "done") {
                for (const [contentIndex, argumentsJson] of argumentsByIndex) {
                  if (forwarded.type === "toolcall_end" && contentIndex !== forwarded.contentIndex)
                    continue;
                  output.push({
                    type: "toolcall_delta",
                    contentIndex,
                    delta: argumentsJson.replace(pattern, reference),
                    partial: forwarded.type === "done" ? forwarded.message : forwarded.partial,
                  });
                  argumentsByIndex.delete(contentIndex);
                }
              }
              partial =
                forwarded.type === "done"
                  ? forwarded.message
                  : forwarded.type === "error"
                    ? forwarded.error
                    : forwarded.partial;
              output.push(forwarded);
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
