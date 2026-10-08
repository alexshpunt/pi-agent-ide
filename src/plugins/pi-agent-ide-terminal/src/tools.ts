import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SshBackendRegistry } from "#src/backend/registry.js";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

import { COMPACT_READ_ROWS } from "#src/extensions/pi-agent-read/src/core/tools/read/read-renderer.js";
import {
  formatAgentTerminalSnapshot,
  terminalOutputTail,
} from "#src/plugins/pi-agent-ide-terminal/src/output-limits.js";
import {
  shellOutputSchema,
  structuredShellResult,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-result.js";
import { renderRunCall, renderRunResult } from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";

import {
  shellSyntaxGuidance,
  remoteBashProfile,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
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
      description:
        "Use the configured local shell syntax, or Bash syntax when cwd selects an SSH target.",
    }),
    background: Type.Optional(
      Type.Boolean({
        description: "Return immediately while the terminal session continues. Defaults to false.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 0.1,
        maximum: 86_400,
        description:
          "Maximum foreground wait in seconds before returning the live session as background. Defaults to 60.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory. Relative local paths resolve from the current workspace. Use ssh://target/path to run Bash in a configured Linux SSH target; its account environment is used instead of the local environment.",
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
  ui: Pick<TerminalUi, "bind" | "notifyWaitTransition">,
  presentation: "full" | "compact" | "disabled" = "compact",
  targets: SshBackendRegistry = new SshBackendRegistry([]),
): void {
  const toolName = process.platform === "win32" ? "powershell" : "bash";
  pi.registerTool(
    defineTool<typeof runParameters, TerminalSessionSnapshot>({
      name: toolName,
      exposure: "direct",
      namespace: {
        name: "ide_terminal",
        description: "Run shell commands in persistent terminal sessions.",
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      label: profile.displayName,
      promptSnippet: `Execute ${profile.displayName} commands in synchronous or background terminal sessions`,
      promptGuidelines: [
        `Do not use ${toolName} commands or scripts to edit files. Use Apply or the standalone editing tools instead. Commands that inherently generate files, such as formatters and code generators, are allowed.`,
      ],
      description: `Use ${toolName} to execute a command in the user's configured ${profile.displayName} shell (${profile.executable}). Every call creates an addressable terminal session. Set background to true to continue without waiting. A foreground wait automatically returns the live session as background on timeout, a stable interactive prompt, or turn abort. Background completion is delivered automatically and wakes the agent. Silent background sessions are treated as potentially stale after two minutes and wake an idle agent for inspection. Sessions survive extension reloads and keep the same shell: source. Output uses the shared Read limits, keeps the tail, and links a complete log file when truncated. ${shellSyntaxGuidance(profile)}`,
      parameters: runParameters,
      outputSchema: shellOutputSchema,
      async execute(_toolCallId, input, signal, onUpdate, context) {
        ui.bind(context);
        const remote = targets.resolve(input.cwd ?? context.cwd, context.cwd);
        const options = {
          command: input.command,
          background: input.background ?? false,
          ...(input.cols === undefined ? {} : { cols: input.cols }),
          ...(input.rows === undefined ? {} : { rows: input.rows }),
        };
        const session = remote
          ? await manager.startRemote({
              ...options,
              remote,
              ...(signal === undefined ? {} : { signal }),
            })
          : manager.start({
              ...options,
              cwd: input.cwd === undefined ? context.cwd : path.resolve(context.cwd, input.cwd),
              shell: profile,
            });
        if (input.background === true && session.status !== "failed") {
          await captureInitialBackgroundPreview(manager, session, onUpdate);
          if (session.status !== "running") session.completionDelivered = true;
          return terminalResult(manager.snapshot(session));
        }
        if (session.status === "failed") return terminalResult(manager.snapshot(session));
        const outcome = await manager.waitForForeground(session.source, {
          signal,
          timeoutMs: (input.timeoutSeconds ?? 60) * 1_000,
        });
        if (outcome.reason === "aborted") ui.notifyWaitTransition(outcome.session);
        return terminalResult(manager.snapshot(outcome.session));
      },
      renderCall(args, theme, context) {
        const mode = context.expanded ? "full" : presentation;
        if (mode === "disabled") return new Text(theme.fg("toolTitle", toolName), 0, 0);
        const command = typeof args.command === "string" ? args.command : "";
        const remote = typeof args.cwd === "string" && args.cwd.startsWith("ssh:");
        const cwd =
          typeof args.cwd === "string"
            ? remote
              ? args.cwd
              : path.resolve(process.cwd(), args.cwd)
            : process.cwd();
        return renderRunCall(
          command,
          args.background === true,
          cwd,
          remote ? remoteBashProfile : profile,
          theme,
        );
      },
      renderResult(result, options, theme) {
        return renderRunResult(
          result.details as Partial<TerminalSessionSnapshot>,
          options.expanded ? "full" : presentation,
          theme,
        );
      },
    }),
  );
}

function terminalPreview(snapshot: TerminalSessionSnapshot) {
  const output = terminalOutputTail(snapshot.output).content;
  return {
    content: [{ type: "text" as const, text: formatAgentTerminalSnapshot(snapshot) }],
    details: {
      ...snapshot,
      output,
      outputStart: snapshot.outputEnd - output.length,
      truncated: snapshot.truncated || output.length < snapshot.output.length,
    },
    isError: snapshot.status === "failed" || snapshot.status === "lost",
  };
}

async function terminalResult(snapshot: TerminalSessionSnapshot) {
  return {
    ...terminalPreview(snapshot),
    structuredContent: await structuredShellResult(snapshot),
  };
}
async function captureInitialBackgroundPreview(
  manager: TerminalSessionManager,
  session: ReturnType<TerminalSessionManager["start"]>,
  onUpdate: ((result: ReturnType<typeof terminalPreview>) => void) | undefined,
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
      onUpdate?.(terminalPreview(snapshot));
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
