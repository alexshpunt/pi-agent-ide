import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { buildParallelToolGuidance } from "#src/composite/parallel-tool-guidance.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const apis = [
  "openai-responses",
  "anthropic-messages",
  "openai-completions",
  "google-generative-ai",
  "openai-codex-responses",
  "google-vertex",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages",
  "custom-api",
] as const;

test("a real Pi session replaces parallel-call guidance after every API switch", async () => {
  await withTempWorkspace(async (cwd) => {
    const captures: { api: string; systemPrompt: string; tools: unknown }[] = [];
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const agentDir = path.join(cwd, "agent");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [path.resolve("src/pi-agent-ide.ts")],
      extensionFactories: [
        (pi) => {
          for (const [index, api] of apis.entries()) {
            // Deliberately misleading provider/model names: only model.api is authoritative.
            pi.registerProvider(`anthropic-openai-fixture-${index}`, {
              api,
              baseUrl: "https://fixture.invalid",
              apiKey: "fixture",
              models: [
                {
                  id: "claude-gpt-gemini",
                  name: "Claude GPT Gemini fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
              streamSimple(model, context) {
                captures.push({
                  api: model.api,
                  systemPrompt: getCurrentSystemPrompt(context.messages),
                  tools: getCurrentTools(context.messages),
                });
                const message: AssistantMessage = {
                  role: "assistant",
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  content: [{ type: "text", text: "Done" }],
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "stop",
                  timestamp: Date.now(),
                };
                const stream = createAssistantMessageEventStream();
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: "stop", message });
                stream.end();
                return stream;
              },
            });
          }
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["read", "search", "insert", "replace", "delete"],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      // Return to the initial API too, exercising replacement in both directions.
      for (const [turn, index] of [...apis.keys(), 0].entries()) {
        const api = apis[index];
        const model = session.modelRuntime.getModel(
          `anthropic-openai-fixture-${index}`,
          "claude-gpt-gemini",
        );
        if (!model) throw Error(`Fixture model missing for ${api}`);
        await session.setModel(model, { persist: false });
        await session.prompt("Inspect the available tools without calling them.");
        const capture = captures.at(-1);
        expect(captures).toHaveLength(turn + 1);
        expect(capture?.api).toBe(api);
        // Compare the selected variant, not its wording: prose changes remain valid.
        const sections = [
          ...(capture?.systemPrompt ?? "").matchAll(
            /<parallel_tool_calls>\n([\s\S]*?)\n<\/parallel_tool_calls>/gu,
          ),
        ];
        expect(sections.map((match) => match[1])).toEqual([buildParallelToolGuidance(api)]);
      }
      const artifacts = testArtifactsDir(import.meta.filename);
      await mkdir(artifacts, { recursive: true });
      const directory = await mkdtemp(path.join(artifacts, "api-switch-"));
      for (const [index, capture] of captures.entries()) {
        await writeFile(
          path.join(directory, `${index}-${capture.api}.json`),
          JSON.stringify(capture, null, 2),
        );
      }
    } finally {
      session.dispose();
    }
  });
}, 90_000);
