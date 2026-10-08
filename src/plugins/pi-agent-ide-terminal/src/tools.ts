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

const createRunParameters = (profile: ShellProfile) =>
  Type.Object(
    {
      command: Type.String({
        minLength: 1,
        description: `Command for ${profile.displayName} (${profile.executable}). ${shellSyntaxGuidance(profile)}`,
      }),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Set true to return after an initial output preview instead of waiting for completion. Defaults to false.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 0.1,
          maximum: 86_400,
          description:
            "Set the foreground wait limit in seconds. On expiry, the live session returns in background without stopping the process. Ignored when background is true. Defaults to 60.",
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

/** Register shell tools and return a callback that releases their active waits on steering. */
export function registerTerminalTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  manager: TerminalSessionManager,
  profile: ShellProfile,
  ui: Pick<TerminalUi, "bind" | "notifyWaitTransition">,
  presentation: "full" | "compact" | "disabled" = "compact",
  targets: SshBackendRegistry = new SshBackendRegistry([]),
): () => void {
  // Keep wait cancellation in this registration, not in a PTY manager retained from older code.
  const foregroundWaits = new Set<AbortController>();
  const toolName = process.platform === "win32" ? "powershell" : "bash";
  const runParameters = createRunParameters(profile);
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
        `Do not use ${toolName} commands or scripts to edit files. Use the standalone editing tools instead. Commands that inherently generate files, such as formatters and code generators, are allowed.`,
      ],
      description: `Use ${toolName} to execute a command in the user's configured shell. Each call creates a new terminal session and returns its shell: source for inspection and interaction.`,
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
        const steering = new AbortController();
        foregroundWaits.add(steering);
        let outcome;
        try {
          outcome = await manager.waitForForeground(session.source, {
            signal:
              signal === undefined ? steering.signal : AbortSignal.any([signal, steering.signal]),
            timeoutMs: (input.timeoutSeconds ?? 60) * 1_000,
          });
        } finally {
          foregroundWaits.delete(steering);
        }
        if (outcome.reason === "aborted" && steering.signal.aborted && signal?.aborted !== true) {
          outcome.session.waitReason = "steering";
          return terminalResult(manager.snapshot(outcome.session));
        }
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
  return () => {
    for (const wait of foregroundWaits) wait.abort();
  };
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
