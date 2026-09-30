import {
  getCurrentSystemPrompt,
  getInitialSystemMessage,
  type JsonValue,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  PiIntegrationTest as UpstreamPiIntegrationTest,
  getToolResultMessage as baseToolResultMessage,
  type PiIntegrationTestOptions,
  type PiIntegrationTestResult,
} from "pi-coding-agent-test/base";

export * from "pi-coding-agent-test/base";

/** Starts the pinned native host without adding the editing fixture's read calls. */
export class PiIntegrationTest extends UpstreamPiIntegrationTest {
  constructor(options: PiIntegrationTestOptions) {
    super({
      ...options,
      // The upstream raw preload relies on private files absent from Pi 0.99's bundled CLI.
      rawMode: options.rawMode ?? false,
      piCommand: options.piCommand ?? process.env.PI_COMMAND,
      environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1", ...options.environment },
    });
  }
}

/** Reads Pi 0.99 system messages instead of the removed provider context prompt field. */
export function getProviderSystemPrompt(result: PiIntegrationTestResult, requestIndex = 0): string {
  const messages = result.providerRequests.at(requestIndex)?.messages;
  if (
    !Array.isArray(messages) ||
    !messages.every(
      (message: unknown): message is { role: string } =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        typeof message.role === "string",
    ) ||
    getInitialSystemMessage(messages) === undefined
  ) {
    throw new TypeError(`Provider request ${requestIndex} did not expose its system prompt`);
  }
  return getCurrentSystemPrompt(messages);
}

/** Reads persisted details without treating unknown renderer state as a native JSON type parameter. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test callers select the detail shape they assert.
export function getToolResultMessage<TDetails = unknown>(
  ...args: Parameters<typeof baseToolResultMessage>
): Omit<ToolResultMessage, "details"> & { details: TDetails } {
  const message = baseToolResultMessage<JsonValue>(...args);
  return { ...message, details: message.details as TDetails };
}
