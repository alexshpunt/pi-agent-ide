import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const model: Model<"anthropic-messages"> = {
  id: "subscription-alias-fixture",
  name: "Synthetic subscription alias fixture",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Exercise the real connector's OAuth hooks without HTTP or real credentials. */
export default function subscriptionAliasProvider(pi: ExtensionAPI): void {
  const snapshots: unknown[] = [];
  let requests = 0;
  const transport: Provider["streamSimple"] = (currentModel, context, options) => {
    const turn = ++requests;
    const content: AssistantMessage["content"] =
      turn === 1
        ? [
            {
              type: "toolCall",
              id: "subscription-direct-alias",
              name: "mcp__agent_ide__replace",
              arguments: { path: "note.txt", start: "OLD", text: "DIRECT" },
            },
          ]
        : turn === 2
          ? [
              {
                type: "toolCall",
                id: "subscription-nested-alias",
                name: "codemode",
                arguments: {
                  code: 'text(await tools.read({path:"docs:editing"})); text(await tools.mcp__agent_ide__replace({path:"note.txt",start:"DIRECT",text:"NESTED"})); text(await tools.read({path:"note.txt"}));',
                },
              },
            ]
          : [{ type: "text", text: "SUBSCRIPTION_ALIAS_FIXTURE_OK" }];
    const message: AssistantMessage = {
      role: "assistant",
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
      content,
      stopReason: turn < 3 ? "toolUse" : "stop",
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
    void (async () => {
      const tools = getCurrentTools(context.messages);
      const system = getCurrentSystemPrompt(context.messages);
      // Native transports own serialization. Keep this small payload in Anthropic's shape and
      // invoke Pi's actual callback so the installed connector transforms it before observation.
      const payload = {
        system,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        messages: [],
      };
      const wire = (await options?.onPayload?.(payload, currentModel)) ?? payload;
      snapshots.push({
        system,
        tools,
        wire,
        activeTools: pi.getActiveTools(),
        aliases: pi.getAllTools().filter((tool) => tool.name.startsWith("mcp__agent_ide__")),
      });
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
      output.push({ type: "done", reason: turn < 3 ? "toolUse" : "stop", message });
      output.end();
    })().catch((error: unknown) => {
      output.push({
        type: "error",
        reason: "error",
        error: { ...message, stopReason: "error", errorMessage: String(error) },
      });
      output.end();
    });
    return output;
  };
  pi.registerProvider({
    id: "anthropic",
    name: "Synthetic Anthropic subscription transport",
    auth: {
      oauth: {
        name: "Synthetic OAuth",
        isSubscription: true,
        async login() {
          throw new Error("This fixture uses only its synthetic stored login");
        },
        async refresh() {
          throw new Error("This fixture must not refresh");
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    getModels: () => [model],
    getAllModels: () => [model],
    stream: (currentModel, context, options) =>
      transport(currentModel, context, { onPayload: options?.onPayload }),
    streamSimple: transport,
  });
  pi.on("session_shutdown", (_event, context) => {
    writeFileSync(
      path.join(context.cwd, "subscription-alias-state.json"),
      JSON.stringify({ requests, snapshots }),
    );
  });
}
