import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";
import type { AgentContent, ResourceResolver } from "pi-agent-resource";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderTerminalScreen } from "#src/plugins/pi-agent-ide-terminal/src/screen-image.js";
import {
  renderTerminalAction,
  renderTerminalActionResult,
  renderTerminalResult,
} from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const WRITE_PREFIX = "\u0000pi-terminal-write\u0000";
const KEYS_PREFIX = "\u0000pi-terminal-keys\u0000";

type TerminalAction = "write" | "insert" | "delete";
interface TerminalActionDetails {
  readonly source: string;
  readonly action: TerminalAction;
  readonly input: string;
  readonly snapshot: Partial<TerminalSessionSnapshot>;
  readonly changedLines: readonly string[];
  readonly status?: string;
  readonly deleted?: boolean;
}

/** Connect shell sessions to the shared read, write, and insert resource interfaces. */
export async function registerTerminalResources(
  pi: ExtensionAPI,
  manager: TerminalSessionManager,
): Promise<void> {
  const pendingOutputEnd = new Map<string, number>();
  const pendingScreen = new Map<string, readonly string[]>();
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "terminal",
    setup(api) {
      api.addResolver({
        resolver: createReadResolver(manager),
        preserveTruncatedOutput: true,
        renderResult(result, options, theme) {
          const details = result.details as { source?: string };
          const session = details.source === undefined ? undefined : manager.get(details.source);
          const snapshot = session === undefined ? {} : manager.snapshot(session);
          return renderTerminalResult(
            session === undefined
              ? snapshot
              : { ...snapshot, output: manager.screenTail(session).join("\n") },
            options.expanded,
            theme,
            "read terminal",
          );
        },
      });
      api.addHandler({
        stage: "pre-read",
        async handler(context) {
          const source = context.request.path;
          if (
            source === undefined ||
            !isShellSource(source) ||
            context.request.views?.includes("image") !== true
          ) {
            return { kind: "continue", context };
          }
          const session = manager.get(source);
          if (session === undefined) {
            return {
              kind: "return",
              result: failure(source, `Unknown terminal session ${source}`),
            };
          }
          try {
            const data = await renderTerminalScreen(manager, source);
            return {
              kind: "return",
              result: {
                content: [{ type: "image", data, mimeType: "image/png" }],
                details: { source: session.source, resolvedBy: "terminal" },
              },
            };
          } catch (error) {
            return {
              kind: "return",
              result: failure(source, error instanceof Error ? error.message : String(error)),
            };
          }
        },
      });
      api.describe(
        'shell:<session> — terminal session status and bounded output. Use views: ["image"] to read the current virtual terminal screen as a PNG.',
      );
      api.addPromptGuideline(
        "Use read with a returned shell:<session> source to inspect terminal status and output. Add the image view when cursor movement, ANSI layout, or a full-screen terminal interface matters.",
      );
    },
  } satisfies ReadPlugin;

  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "terminal",
    setup(api) {
      api.addResolver({ resolver: createInputResolver(manager) });
      api.tool("write").addHandler({
        stage: "text-pre-edit",
        handler: async (state) => {
          rememberOutputEnd(state.input, manager, pendingOutputEnd);
          await rememberScreen(state.input, manager, pendingScreen);
          return transformWriteInput(state, WRITE_PREFIX);
        },
      });
      api.tool("insert").addHandler({
        stage: "text-pre-edit",
        handler: async (state) => {
          await rememberScreen(state.input, manager, pendingScreen);
          rememberOutputEnd(state.input, manager, pendingOutputEnd);
          return transformInsertInput(state);
        },
      });
      for (const tool of ["write", "insert", "delete"] as const) {
        api.addToolRenderer({
          tool,
          matches: (value, phase) => isTerminalRenderValue(value, phase),
          renderCall(arguments_, theme, context) {
            const input = arguments_ as Record<string, unknown>;
            const session = typeof input.path === "string" ? manager.get(input.path) : undefined;
            const state = context.state as { snapshot?: TerminalSessionSnapshot };
            if (session !== undefined) state.snapshot = manager.snapshot(session);
            return renderTerminalAction(
              state.snapshot ?? {},
              tool,
              terminalInputLabel(tool, input),
              [],
              theme,
            );
          },
          renderResult(result, _options, theme) {
            const details = terminalActionDetails(result.details);
            return renderTerminalActionResult(details.action, details.changedLines, theme);
          },
        });
      }
      api.describe(
        "For shell:<session> resources, write sends exact terminal input, insert sends named keys at end, and delete terminates and removes the session. replace is unsupported.",
      );
      api
        .tool("write")
        .describe(
          "When path is shell:<session>, send content exactly as terminal input without adding Enter.",
        );
      api
        .tool("insert")
        .describe(
          "When path is shell:<session>, omit anchor or use end, keep before false, and put whitespace- or comma-separated named keys and chords such as Enter, Ctrl+C, Ctrl+Left, Ctrl+Shift+Left, Up, or Backspace in text. Use Unix caret forms such as ^C and ^U for control characters.",
        );
    },
  } satisfies TextEditorPlugin;

  await Promise.all([connectReadPlugin(pi, readPlugin), connectTextEditorPlugin(pi, editorPlugin)]);

  pi.on("tool_result", async (event, context) => {
    if (!isRecord(event.input)) return;
    const requestedSource = event.input.path;
    if (
      event.toolName === "replace" &&
      typeof requestedSource === "string" &&
      isShellSource(requestedSource)
    ) {
      return {
        content: [
          {
            type: "text",
            text: `replace is unsupported for ${requestedSource}; use write for text, insert for keys, or delete to terminate and remove the session.`,
          },
        ],
        details: event.details,
        isError: true,
      };
    }
    if (
      event.toolName === "delete" &&
      typeof requestedSource === "string" &&
      isShellSource(requestedSource)
    ) {
      const session = manager.get(requestedSource);
      if (session === undefined) return;
      const snapshot = manager.snapshot(session);
      return manager.delete(requestedSource).then(
        () => ({
          content: [
            { type: "text" as const, text: `Deleted terminal session ${requestedSource}.` },
          ],
          details: {
            source: requestedSource,
            deleted: true,
            snapshot,
            action: "delete" as const,
            input: "session",
            changedLines: [],
          } satisfies TerminalActionDetails,
          isError: false,
        }),
        (error: unknown) => ({
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          details: { source: requestedSource, deleted: false },
          isError: true,
        }),
      );
    }
    if (event.toolName !== "write" && event.toolName !== "insert") return;
    if (event.isError) return;
    const source = event.input.path;
    if (typeof source !== "string" || !isShellSource(source)) return;
    const session = manager.get(source);
    if (session === undefined) return;
    const beforeScreen = pendingScreen.get(source) ?? manager.screenRows(session);
    pendingScreen.delete(source);
    const previousEnd = pendingOutputEnd.get(source) ?? session.outputStart + session.output.length;
    pendingOutputEnd.delete(source);
    await manager.waitForOutputAfter(session, previousEnd);
    const snapshot = manager.snapshot(session);
    const action = event.toolName;
    const input = terminalInputLabel(action, event.input);
    const region = manager.screenChangeRegion(session, beforeScreen, 6);
    const content: Array<
      | { readonly type: "text"; readonly text: string }
      | { readonly type: "image"; readonly data: string; readonly mimeType: "image/png" }
    > = [{ type: "text", text: `Sent ${input} to ${session.source}.` }];
    if (context.model?.input.includes("image") === true) {
      content.push({
        type: "image",
        data: await renderTerminalScreen(manager, source, {
          start: region.startRow,
          count: region.lines.length,
        }),
        mimeType: "image/png",
      });
    }
    return {
      content,
      details: {
        source: session.source,
        action,
        status: session.status,
        snapshot,
        input,
        changedLines: region.lines,
      } satisfies TerminalActionDetails,
      isError: event.isError,
    };
  });
}

function createReadResolver(manager: TerminalSessionManager): ResourceResolver {
  return {
    id: "terminal",
    async tryResolve(source) {
      if (!isShellSource(source)) return { kind: "not-handled" };
      const session = manager.get(source);
      if (session === undefined)
        return { kind: "failed", error: new Error(`Unknown terminal session ${source}`) };
      return {
        kind: "resolved",
        resource: {
          source: session.source,
          async read() {
            const snapshot = manager.snapshot(session);
            return [{ type: "text", text: formatSnapshot(snapshot) }];
          },
        },
      };
    },
  };
}

function createInputResolver(manager: TerminalSessionManager): ResourceResolver {
  return {
    id: "terminal-input",
    async tryResolve(source) {
      if (!isShellSource(source)) return { kind: "not-handled" };
      const session = manager.get(source);
      if (session === undefined)
        return { kind: "failed", error: new Error(`Unknown terminal session ${source}`) };
      return {
        kind: "resolved",
        resource: {
          source: session.source,
          skipPostEdit: true,
          async read() {
            return [{ type: "text", text: "terminal input" }];
          },
          async write(content) {
            const text = singleText(content);
            const writeIndex = text.indexOf(WRITE_PREFIX);
            const keysIndex = text.indexOf(KEYS_PREFIX);
            if (writeIndex >= 0) {
              manager.write(session.source, text.slice(writeIndex + WRITE_PREFIX.length));
              return;
            }
            if (keysIndex >= 0) {
              manager.sendKeys(session.source, text.slice(keysIndex + KEYS_PREFIX.length).trim());
              return;
            }
            throw new Error(`Unsupported text operation for ${session.source}`);
          },
        },
      };
    },
  };
}

function transformWriteInput<State extends { readonly input: unknown }>(
  state: State,
  prefix: string,
): State {
  if (!isRecord(state.input) || !isShellSourceValue(state.input.path)) return state;
  return {
    ...state,
    input: {
      ...state.input,
      content: `${prefix}${typeof state.input.content === "string" ? state.input.content : ""}`,
    },
  };
}

function transformInsertInput<State extends { readonly input: unknown }>(state: State): State {
  if (!isRecord(state.input) || !isShellSourceValue(state.input.path)) return state;
  if (state.input.before === true)
    throw new Error("Shell keys can only be inserted after the active input position");
  return {
    ...state,
    input: {
      ...state.input,
      anchor: "end",
      before: false,
      text: `${KEYS_PREFIX}${typeof state.input.text === "string" ? state.input.text : ""}`,
    },
  };
}

function formatSnapshot(snapshot: ReturnType<TerminalSessionManager["snapshot"]>): string {
  const metadata = [
    `session: ${snapshot.source}`,
    `status: ${snapshot.status}`,
    `shell: ${snapshot.shell}`,
    `cwd: ${snapshot.cwd}`,
    `elapsedMs: ${snapshot.elapsedMs}`,
    snapshot.exitCode === undefined ? undefined : `exitCode: ${snapshot.exitCode}`,
    snapshot.signal === undefined ? undefined : `signal: ${snapshot.signal}`,
    `outputRange: ${snapshot.outputStart}-${snapshot.outputEnd}`,
    `truncated: ${String(snapshot.truncated)}`,
  ].filter((line): line is string => line !== undefined);
  return `${metadata.join("\n")}\n\n${snapshot.output}`;
}

function singleText(content: AgentContent): string {
  if (content.length !== 1 || content[0].type !== "text") {
    throw new Error("Terminal input must contain one text block");
  }
  return content[0].text;
}

function failure(source: string, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      source,
      failure: { code: "READ_FAILED" as const, source, resolverId: "terminal", message },
    },
    isError: true,
  };
}

function isShellSource(value: string): boolean {
  return /^shell:[a-f\d]{12}$/u.test(value);
}

function isShellSourceValue(value: unknown): value is string {
  return typeof value === "string" && isShellSource(value);
}

function terminalActionDetails(value: unknown): TerminalActionDetails {
  if (!isRecord(value) || !isRecord(value.snapshot)) {
    throw new TypeError("Invalid terminal action result");
  }
  const snapshot = value.snapshot;
  const action = value.action;
  if (action !== "write" && action !== "insert" && action !== "delete") {
    throw new TypeError("Invalid terminal action");
  }
  return {
    source: typeof value.source === "string" ? value.source : "shell:unknown",
    action,
    input: typeof value.input === "string" ? value.input : "",
    changedLines: Array.isArray(value.changedLines)
      ? value.changedLines.filter((line): line is string => typeof line === "string")
      : [],
    snapshot: {
      ...(typeof snapshot.shell === "string" ? { shell: snapshot.shell } : {}),
      ...(typeof snapshot.cwd === "string" ? { cwd: snapshot.cwd } : {}),
      ...(typeof snapshot.command === "string" ? { command: snapshot.command } : {}),
      ...(typeof snapshot.background === "boolean" ? { background: snapshot.background } : {}),
      ...(typeof snapshot.status === "string"
        ? { status: snapshot.status as TerminalSessionSnapshot["status"] }
        : {}),
    },
  };
}

async function rememberScreen(
  input: unknown,
  manager: TerminalSessionManager,
  pending: Map<string, readonly string[]>,
): Promise<void> {
  if (!isRecord(input) || typeof input.path !== "string" || !isShellSource(input.path)) return;
  const session = manager.get(input.path);
  if (session !== undefined) await session.screenReady;
  if (session !== undefined) pending.set(input.path, manager.screenRows(session));
}
function rememberOutputEnd(
  input: unknown,
  manager: TerminalSessionManager,
  pending: Map<string, number>,
): void {
  if (!isRecord(input) || typeof input.path !== "string" || !isShellSource(input.path)) return;
  const session = manager.get(input.path);
  if (session !== undefined) pending.set(input.path, session.outputStart + session.output.length);
}
function terminalInputLabel(tool: TerminalAction, input: Record<string, unknown>): string {
  if (tool === "delete") return "session";
  const value = tool === "write" ? input.content : input.text;
  const label = typeof value === "string" ? value : "";
  return tool === "write" ? `text ${JSON.stringify(label)}` : `keys ${label}`;
}

function isTerminalRenderValue(value: unknown, phase: "call" | "result"): boolean {
  if (!isRecord(value)) return false;
  if (phase === "call") return typeof value.path === "string" && isShellSource(value.path);
  const details = value.details;
  return isRecord(details) && typeof details.source === "string" && isShellSource(details.source);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
