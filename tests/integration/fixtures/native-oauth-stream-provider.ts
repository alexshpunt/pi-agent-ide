import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Native OAuth fixture",
  provider: "native-oauth-stream-fixture",
  api: "openai-completions",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A real native registration whose OAuth and transport never access the network. */
export default function nativeOAuthStreamProvider(pi: ExtensionAPI): void {
  let requests = 0;
  let authResolutions = 0;
  let rebound = false;
  const snapshots: {
    phase: string;
    oauth: boolean;
    models: boolean;
    restored: boolean;
    name?: string;
  }[] = [];
  const transport: Provider["streamSimple"] = (currentModel) => {
    const first = ++requests === 1;
    const message: AssistantMessage = {
      role: "assistant",
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
      content: first
        ? [
            {
              type: "toolCall",
              id: "native-replace",
              name: "replace",
              arguments: { path: "note.txt", start: "OLD", text: "NEW" },
            },
          ]
        : [{ type: "text", text: "NATIVE_OAUTH_STREAM_OK" }],
      stopReason: first ? "toolUse" : "stop",
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
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => {
      output.push({ type: "start", partial: message });
      const call = message.content[0];
      if (call?.type === "toolCall") {
        output.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        output.push({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify(call.arguments),
          partial: message,
        });
        output.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      }
      output.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      output.end();
    });
    return output;
  };
  const provider: Provider = {
    id: model.provider,
    name: "Native fixture",
    auth: {
      oauth: {
        name: "Synthetic OAuth",
        isSubscription: true,
        async login() {
          throw new Error("This regression uses only its synthetic stored login");
        },
        async refresh() {
          throw new Error("This regression must not refresh");
        },
        async toAuth(credential) {
          authResolutions++;
          return { apiKey: credential.access };
        },
      },
    },
    getModels: () => [model],
    getAllModels: () => [model],
    stream: (currentModel, context) => transport(currentModel, context),
    streamSimple: transport,
  };
  pi.registerProvider(provider);
  const observe = (phase: string, context: ExtensionContext) => {
    const active = context.modelRegistry.getRegisteredNativeProvider(model.provider);
    snapshots.push({
      phase,
      oauth: active?.auth.oauth === provider.auth.oauth,
      models: active?.getModels === provider.getModels,
      restored: active?.streamSimple === transport,
      name: active?.name,
    });
  };
  pi.on("session_start", (_event, context) => observe("start", context));
  pi.on("turn_start", (_event, context) => observe("request", context));
  pi.on("message_end", (event, context) => {
    if (event.message.role !== "assistant" || rebound) return;
    const active = context.modelRegistry.getRegisteredNativeProvider(model.provider);
    if (!active) return;
    rebound = true;
    pi.registerProvider({ ...active, name: "Rebound native fixture", streamSimple: transport });
  });
  pi.on("session_shutdown", (_event, context) => {
    observe("shutdown", context);
    writeFileSync(
      path.join(context.cwd, "native-provider-state.json"),
      JSON.stringify({ requests, authResolutions, rebound, snapshots }),
    );
  });
}
