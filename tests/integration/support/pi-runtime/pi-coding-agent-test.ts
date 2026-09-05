import {
  assistantMessage,
  PiIntegrationTest as BasePiIntegrationTest,
  type PiIntegrationTestOptions,
  testArtifactsDir,
  text,
  toolCall,
  type ToolSelection,
} from "pi-coding-agent-test/base";
import { expect } from "vitest";

export { type ChunkSpec, chunkString, testArtifactsDir } from "pi-coding-agent-test/base";

export {
  emitMessageUpdateEvents,
  generateToolCallEvents,
  type MessageUpdateEvent,
  type MessageUpdateHandler,
  type PartialToolCallBlock,
  type ToolCallDeltaEvent,
  type ToolCallEndEvent,
  type ToolCallEvent,
  type ToolCallInput,
  type ToolCallStartEvent,
} from "pi-coding-agent-test/base";

export {
  getProviderRequestLastMessageText,
  getProviderSystemPrompt,
  getToolCallNames,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolExecutions,
  getToolResultMessage,
  getToolResultText,
  type ToolExecutionTrace,
} from "pi-coding-agent-test/base";

export {
  type AssistantContentBlock,
  assistantMessage,
  type AssistantMessageScenario,
  type PiIntegrationTestArtifacts,
  type PiIntegrationTestOptions,
  type PiIntegrationTestResult,
  type StopReason,
  text,
  toolCall,
  type ToolCallBlock,
  type ToolSelection,
  type TraceEvent,
  type TuiSize,
} from "pi-coding-agent-test/base";

function includeReadTool(tools: ToolSelection | undefined): ToolSelection | undefined {
  if (tools === undefined) {
    return undefined;
  }

  if (Array.isArray(tools)) {
    return [...new Set([...(tools as readonly string[]), "read"])];
  }

  const selection = tools as { include?: readonly string[]; exclude?: readonly string[] };
  const include =
    selection.include === undefined ? undefined : [...new Set([...selection.include, "read"])];
  const exclude = selection.exclude?.filter((name) => name !== "read");
  return {
    ...selection,
    ...(include !== undefined && { include }),
    ...(exclude !== undefined && { exclude }),
  };
}

function editedFiles(
  conversation: readonly ReturnType<typeof assistantMessage>[],
): readonly string[] {
  const files = new Set<string>();

  for (const message of conversation) {
    for (const block of message.blocks) {
      if (block.type !== "toolCall" || block.name === "read" || block.arguments === undefined) {
        continue;
      }

      for (const key of ["path", "target"] as const) {
        const value = block.arguments[key];

        if (typeof value === "string" && value.length > 0) {
          files.add(value);
        }
      }
    }
  }

  return [...files];
}

function readMessage(id: string, filePath: string) {
  return assistantMessage(
    [
      toolCall({
        id,
        name: "read",
        // Surrounding reads mirror an editing agent and request hash anchors.
        arguments: { path: filePath, offset: 1, views: ["anchors"] },
      }),
    ],
    { stopReason: "toolUse" as const },
  );
}

function withBoundary(
  message: ReturnType<typeof assistantMessage>,
  label: "PREFLIGHT FINISHED" | "POSTFLIGHT STARTED",
): ReturnType<typeof assistantMessage> {
  return {
    ...message,
    blocks: [
      text(`╭──────────────────────────╮\n│  ${label.padEnd(23)} │\n╰──────────────────────────╯`, {
        delayMs: 0,
      }),
      ...message.blocks,
    ],
  };
}

function withRequiredReadPreflightPostflight(
  conversation: readonly ReturnType<typeof assistantMessage>[],
  idPrefix: string,
): readonly ReturnType<typeof assistantMessage>[] {
  const terminalMessage = conversation.at(-1);

  if (terminalMessage === undefined) {
    return conversation;
  }

  const files = editedFiles(conversation);

  if (files.length === 0) {
    return conversation;
  }

  const preflight = files.map((filePath, index) =>
    readMessage(`${idPrefix}-read-preflight-${index}`, filePath),
  );
  const mutations = conversation
    .slice(0, -1)
    .map((message, index) => (index === 0 ? withBoundary(message, "PREFLIGHT FINISHED") : message));
  const postflight = files.map((filePath, index) => {
    const message = readMessage(`${idPrefix}-read-postflight-${index}`, filePath);

    return index === 0 ? withBoundary(message, "POSTFLIGHT STARTED") : message;
  });

  return [...preflight, ...mutations, ...postflight, terminalMessage];
}

/**
Root integration runner. Every file mutation is surrounded by real read calls.
*/
export class PiIntegrationTest extends BasePiIntegrationTest {
  public constructor(options: PiIntegrationTestOptions) {
    const testPath = expect.getState().testPath;

    if (testPath === undefined) {
      throw new Error("Cannot determine the current integration test file");
    }

    const tools = includeReadTool(options.tools);

    super({
      ...options,
      ...(tools !== undefined && { tools }),
      conversation: withRequiredReadPreflightPostflight(
        options.conversation ?? [],
        options.testName,
      ),
      artifactsDir: options.artifactsDir ?? testArtifactsDir(testPath),
      isolateUserResources: options.isolateUserResources ?? true,
      environment: { PI_SKIP_VERSION_CHECK: "1", ...options.environment },
    });
  }
}
