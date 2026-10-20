import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A synthetic transport writes its invocation count; reopening must never call it. */
export default function capabilityHistoryProvider(pi: ExtensionAPI): void {
  let calls = 0;
  pi.registerProvider("history-fixture", {
    api: "anthropic-messages",
    baseUrl: "https://history-fixture.invalid",
    apiKey: "SYNTHETIC_HISTORY_NOT_A_CREDENTIAL",
    models: [
      {
        id: "history-model",
        name: "History fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model) {
      appendFileSync("/state/provider-calls", "request\n");
      const first = calls++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: first ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: first
          ? [
              {
                type: "toolCall",
                id: "history-read",
                name: "read",
                arguments: { path: "note.txt" },
              },
            ]
          : [{ type: "text", text: "HISTORY_FINAL_ANSWER" }],
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (first) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "history-read",
            name: "read",
            arguments: { path: "note.txt" },
          },
          partial: message,
        });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "HISTORY_FINAL_ANSWER",
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: "HISTORY_FINAL_ANSWER",
          partial: message,
        });
      }
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
  pi.on("agent_settled", () => process.stdout.write("\nHISTORY_LIVE_SETTLED\n"));
}
