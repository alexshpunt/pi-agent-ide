import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Edit lifecycle fixture",
  provider: "edit-lifecycle",
  api: "openai-completions",
  baseUrl: "http://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

test("reload and persisted resume cannot restore the legacy edit declaration", async () => {
  const root = path.resolve(".tmp/hidden-edit-lifecycle");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  const agentDir = path.join(cwd, "agent");
  const declarations: string[][] = [];
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      path.resolve("src/pi-agent-ide.ts"),
      path.resolve("tests/integration/fixtures/edit-availability-probe.ts"),
    ],
    extensionFactories: [
      (pi) => {
        pi.registerProvider(model.provider, {
          apiKey: "local-fixture",
          baseUrl: model.baseUrl,
          api: model.api,
          models: [
            {
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: model.cost,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            },
          ],
          streamSimple(currentModel, context) {
            declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
            const last = context.messages.at(-1);
            const tool =
              last?.role === "user"
                ? "edit"
                : last?.role === "toolResult" && last.toolName === "edit"
                  ? "edit_availability_probe"
                  : undefined;
            const call = tool !== undefined;
            const message: AssistantMessage = {
              role: "assistant",
              content: call
                ? [
                    {
                      type: "toolCall",
                      id: randomUUID(),
                      name: tool,
                      arguments: {},
                    },
                  ]
                : [{ type: "text", text: "Checked availability." }],
              api: currentModel.api,
              provider: currentModel.provider,
              model: currentModel.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: call ? "toolUse" : "stop",
              timestamp: Date.now(),
            };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
              stream.end();
            });
            return stream;
          },
        });
      },
    ],
  });
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  // A real persisted transcript may still advertise the old placeholder.
  manager.appendMessage({
    role: "system",
    content: "Legacy session",
    toolsAdded: [
      { name: "edit", description: "Legacy edit", parameters: { type: "object", properties: {} } },
    ],
    timestamp: Date.now(),
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: ["edit", "read", "edit_availability_probe"],
    }));
    for (const phase of ["loaded", "reloaded", "resumed"] as const) {
      if (phase === "reloaded") await session.reload();
      if (phase === "resumed") {
        const file = session.sessionFile;
        if (!file) throw new Error("Missing persisted session");
        const captured = path.join(root, "captured-session.jsonl");
        await copyFile(file, captured);
        session.dispose();
        await loader.reload();
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          resourceLoader: loader,
          settingsManager,
          sessionManager: SessionManager.open(captured),
          tools: ["edit", "read", "edit_availability_probe"],
        }));
      }
      await session.bindExtensions({});
      session.setActiveToolsByName(["edit", "read", "edit_availability_probe"]);
      expect(session.getActiveToolNames()).not.toContain("edit");
      expect(session.getCallableToolNames()).not.toContain("edit");
      expect(session.getAllTools().find((tool) => tool.name === "edit")?.exposure).toBe("hidden");
      await session.prompt(`Check availability after ${phase}.`);
      const direct = session.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "edit",
      );
      if (direct?.role !== "toolResult") throw new Error("Missing direct edit denial");
      expect(direct.isError).toBe(true);
      expect(direct.content).toEqual([{ type: "text", text: "Tool edit not found" }]);
      const result = session.messages.findLast(
        (message) =>
          message.role === "toolResult" && message.toolName === "edit_availability_probe",
      );
      if (result?.role !== "toolResult") throw new Error("Missing availability result");
      const block = result.content.find((part) => part.type === "text");
      if (block?.type !== "text") throw new Error("Missing availability data");
      const availability = JSON.parse(block.text) as {
        nested: { isError: boolean; result: { content: { text: string }[] } };
      };
      expect(availability.nested.isError).toBe(true);
      expect(availability.nested.result.content[0]?.text).toBe("Tool edit not found");
    }
    expect(declarations).toHaveLength(9);
    for (const names of declarations) expect(names).not.toContain("edit");
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
