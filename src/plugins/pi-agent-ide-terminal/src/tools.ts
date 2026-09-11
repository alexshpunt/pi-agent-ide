import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { COMPACT_READ_ROWS } from "#src/extensions/pi-agent-read/src/core/tools/read/read-renderer.js";
import { renderRunCall, renderRunResult } from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";

import { shellSyntaxGuidance } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import type { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";
import type {
  ShellProfile,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const runParameters = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description: "Command written in the syntax of the configured system shell",
    }),
    background: Type.Optional(
      Type.Boolean({
        description: "Return immediately while the terminal session continues. Defaults to false.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory. Relative paths resolve from the current workspace.",
      }),
    ),
    cols: Type.Optional(
      Type.Integer({ minimum: 20, maximum: 300, description: "Virtual terminal width in cells" }),
    ),
    rows: Type.Optional(
      Type.Integer({ minimum: 5, maximum: 120, description: "Virtual terminal height in cells" }),
    ),
  },
  { additionalProperties: false },
);

/** Register terminal process lifecycle tools with platform-specific shell guidance. */
export function registerTerminalTools(
  pi: ExtensionAPI,
  manager: TerminalSessionManager,
  profile: ShellProfile,
  ui: Pick<TerminalUi, "bind">,
): void {
  pi.registerTool(
    defineTool<typeof runParameters, TerminalSessionSnapshot>({
      name: "run",
      label: `${profile.displayName} run`,
      promptSnippet: `Run ${profile.displayName} commands in synchronous or background terminal sessions`,
      promptGuidelines: [
        `Write commands for ${profile.displayName}; commands are not translated between shell languages.`,
        "Use background for servers, watchers, long builds, and work that can finish while you continue. Use the returned shell: source with read, write, insert, and delete.",
      ],
      description: `Use run to execute a command in the user's configured ${profile.displayName} shell (${profile.executable}). Every call creates an addressable terminal session. Set background to true to continue without waiting; completion is delivered automatically and wakes the agent. ${shellSyntaxGuidance(profile)}`,
      parameters: runParameters,
      async execute(_toolCallId, input, signal, onUpdate, context) {
        ui.bind(context);
        const cwd = input.cwd === undefined ? context.cwd : path.resolve(context.cwd, input.cwd);
        const session = manager.start({
          command: input.command,
          background: input.background ?? false,
          cwd,
          shell: profile,
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows }),
        });
        if (input.background === true && session.status !== "failed") {
          await captureInitialBackgroundPreview(manager, session, onUpdate);
          if (session.status !== "running") session.completionDelivered = true;
          return terminalResult(manager.snapshot(session));
        }
        if (session.status === "failed") return terminalResult(manager.snapshot(session));
        const completed = await manager.wait(session.source, signal);
        return terminalResult(manager.snapshot(completed));
      },
      renderCall(args, theme) {
        const command = typeof args.command === "string" ? args.command : "";
        const cwd =
          typeof args.cwd === "string" ? path.resolve(process.cwd(), args.cwd) : process.cwd();
        return renderRunCall(command, args.background === true, cwd, profile, theme);
      },
      renderResult(result, options, theme) {
        return renderRunResult(
          result.details as Partial<TerminalSessionSnapshot>,
          options.expanded,
          theme,
        );
      },
    }),
  );
}

function terminalResult(snapshot: TerminalSessionSnapshot) {
  const excerpt = outputExcerpt(snapshot.output);
  const lines = [
    `session: ${snapshot.source}`,
    `status: ${snapshot.status}`,
    `shell: ${snapshot.shell}`,
    `cwd: ${snapshot.cwd}`,
    `elapsedMs: ${snapshot.elapsedMs}`,
    snapshot.exitCode === undefined ? undefined : `exitCode: ${snapshot.exitCode}`,
    snapshot.signal === undefined ? undefined : `signal: ${snapshot.signal}`,
    snapshot.error === undefined ? undefined : `error: ${snapshot.error}`,
    `outputRange: ${snapshot.outputStart}-${snapshot.outputEnd}`,
    snapshot.truncated ? "output: truncated; use read for the retained log" : undefined,
    excerpt.length === 0 ? "output: (empty)" : `output:\n${excerpt}`,
  ].filter((line): line is string => line !== undefined);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: snapshot,
    isError: snapshot.status === "failed" || snapshot.status === "lost",
  };
}

function outputExcerpt(output: string): string {
  const plain = stripVTControlCharacters(output).trimEnd();
  return plain.length <= 8_000 ? plain : `[earlier output omitted]\n${plain.slice(-8_000)}`;
}

async function captureInitialBackgroundPreview(
  manager: TerminalSessionManager,
  session: ReturnType<TerminalSessionManager["start"]>,
  onUpdate: ((result: ReturnType<typeof terminalResult>) => void) | undefined,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let unsubscribe = (): void => {};
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const publish = (): void => {
      const snapshot = manager.snapshot(session);
      onUpdate?.(terminalResult(snapshot));
      const rows = stripVTControlCharacters(snapshot.output)
        .replaceAll("\r", "")
        .split("\n")
        .filter((line) => line.length > 0).length;
      if (rows >= COMPACT_READ_ROWS || snapshot.status !== "running") finish();
    };
    unsubscribe = manager.onDidChange((changed) => {
      if (changed.id === session.id) publish();
    });
    timeout = setTimeout(finish, 2_000);
    publish();
  });
}
