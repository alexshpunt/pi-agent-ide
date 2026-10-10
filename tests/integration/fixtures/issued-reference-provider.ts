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
                  : new RegExp(`(?:^|\\n)\\s*(${line}#[A-F\\d]{4,64})`, "u");
          const value = expression.exec(shown)?.[1];
          if (!value) throw new Error(`Missing ${kind} reference in ${id}`);
          return value;
        };
        void (async () => {
          try {
            for await (const event of delegate(currentModel, transcript, options)) {
              const forwarded = JSON.parse(
                JSON.stringify(event).replace(
                  /\$issued-(uuid|item|search(?:match|allline|allmatch)?|anchor):([a-z][a-z\d-]*)(?::(\d+))?/gu,
                  reference,
                ),
              ) as AssistantMessageEvent;
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
