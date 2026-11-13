import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";

/** The result of an IDE call, as the unified tool_result hook sees it. */
export interface ScriptValueInput {
  /** Readable result with its system-result envelope, exactly as a direct call shows it. */
  readonly shown: string;
  /** The tool's validated record `{ status, data, errors }`, or the raw structured content. */
  readonly outcome: unknown;
  readonly content: AgentToolResult<unknown>["content"];
  readonly details: unknown;
  /** Directory of the session that made the call; values show paths inside it relative to it. */
  readonly cwd?: string;
}

/**
 * What a Codemode script gets from one IDE tool. Each tool owns its value in its own module, so a
 * change to one tool's value touches only that module. A failed call always resolves to `null`;
 * the declared schema adds `null` to `schema`.
 */
export interface ScriptValue {
  /** JSON Schema of the value of a successful call. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** The value of a successful call. Never derived from rendered prose or private records. */
  project(input: ScriptValueInput): JsonValue;
  /**
   * The value of a failed call that its resource provider chose to return to scripts, such as the
   * receipt of a refused computer action. Without one, a failed call resolves to `null`.
   */
  failed?(input: ScriptValueInput): JsonValue | undefined;
  /**
   * Whether a call that a direct result reports as an error succeeded for scripts, such as a
   * command that exited with a non-zero code. It then resolves to `project` and the Codemode result
   * does not list it as failed.
   */
  succeeded?(input: ScriptValueInput): boolean;
}
