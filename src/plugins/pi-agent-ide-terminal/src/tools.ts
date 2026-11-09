import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { SshTargetOs } from "#src/backend/identity.ts";
import { SshBackendRegistry, type ResolvedSshSource } from "#src/backend/registry.ts";
import { targetOs } from "#src/backend/ssh-transport.ts";

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

import { COMPACT_READ_ROWS } from "#src/extensions/pi-agent-read/src/core/tools/read/read-renderer.ts";
import {
  formatAgentTerminalSnapshot,
  terminalOutputTail,
} from "#src/plugins/pi-agent-ide-terminal/src/output-limits.ts";
import {
  shellOutputSchema,
  structuredShellResult,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-result.ts";
import { renderRunCall, renderRunResult } from "#src/plugins/pi-agent-ide-terminal/src/renderer.ts";

import {
  shellSyntaxGuidance,
  remoteShellProfile,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import type { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.ts";
import type {
  ShellProfile,
  TerminalExecutionOrigin,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.ts";

const osLabel: Readonly<Record<SshTargetOs, string>> = { linux: "Linux", windows: "Windows" };
const hostOs: SshTargetOs = process.platform === "win32" ? "windows" : "linux";
/** Cross-OS tools are named for the shell they run. */
const remoteToolName = (os: SshTargetOs): string =>
  os === "windows" ? "remote_powershell" : "remote_bash";

/** One shell tool: the local tool also serves same-OS targets, a remote tool only its OS. */
interface ShellToolScope {
  readonly name: string;
  /** OS of the SSH targets this tool accepts. */
  readonly targetOs: SshTargetOs;
  readonly remoteOnly: boolean;
}

const createRunParameters = (profile: ShellProfile, scope: ShellToolScope) =>
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
          description: scope.remoteOnly
            ? `Working directory on a ${osLabel[scope.targetOs]} SSH target: ssh://<target>/${scope.targetOs === "windows" ? "C:/path" : "absolute/path"}.`
            : "Working directory. Relative paths resolve from the current workspace.",
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

/** Reject a working directory this tool cannot serve, naming the tool that can. */
function assertScope(
  scope: ShellToolScope,
  remote: ResolvedSshSource | undefined,
): asserts remote is ResolvedSshSource | undefined {
  if (remote === undefined) {
    if (scope.remoteOnly) {
      throw new Error(
        `${scope.name} runs only on remote targets. Pass cwd as an ssh:// directory of a ${osLabel[scope.targetOs]} target.`,
      );
    }
    return;
  }
  const actual = targetOs(remote.backend.target);
  if (actual === scope.targetOs) return;
  const owner =
    actual === hostOs ? (hostOs === "windows" ? "powershell" : "bash") : remoteToolName(actual);
  throw new Error(
    `${remote.location.source} is on a ${osLabel[actual]} target. Use ${owner} for it; ${scope.name} accepts ${osLabel[scope.targetOs]} targets.`,
  );
}

/**
 * Register the shell tools and return a callback that releases their active waits on steering.
 * The local tool also runs on same-OS SSH targets. A remote-only tool for the other OS appears
 * only when a target of that OS is configured.
 */
export function registerTerminalTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  manager: TerminalSessionManager,
  profile: ShellProfile,
  ui: Pick<TerminalUi, "bind" | "notifyWaitTransition">,
  presentation:
    | "full"
    | "compact"
    | "disabled"
    | (() => "full" | "compact" | "disabled") = "compact",
  targets: SshBackendRegistry = new SshBackendRegistry([]),
  executionOrigin?: (toolCallId: string, context: ExtensionContext) => TerminalExecutionOrigin,
): () => void {
  // Keep wait cancellation in this registration, not in a PTY manager retained from older code.
  const foregroundWaits = new Set<AbortController>();
  registerShellTool(
    { name: hostOs === "windows" ? "powershell" : "bash", targetOs: hostOs, remoteOnly: false },
    profile,
  );
  const otherOs: SshTargetOs = hostOs === "windows" ? "linux" : "windows";
  if (targets.hasTargetOs(otherOs)) {
    registerShellTool(
      { name: remoteToolName(otherOs), targetOs: otherOs, remoteOnly: true },
      remoteShellProfile(otherOs),
    );
  }

  function registerShellTool(scope: ShellToolScope, toolProfile: ShellProfile): void {
    const toolName = scope.name;
    const runParameters = createRunParameters(toolProfile, scope);
    // A remote-only tool has nowhere to run without an SSH directory.
    if (scope.remoteOnly) (runParameters.required as string[]).push("cwd");
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
        label: toolProfile.displayName,
        promptSnippet: scope.remoteOnly
          ? `Execute ${toolProfile.displayName} commands on ${osLabel[scope.targetOs]} SSH targets`
          : `Execute ${toolProfile.displayName} commands in synchronous or background terminal sessions`,
        promptGuidelines: [`Edit files with the edit tools, not ${toolName}.`],
        description: scope.remoteOnly
          ? `Use ${toolName} to execute a command in ${toolProfile.displayName} on a configured ${osLabel[scope.targetOs]} SSH target. It runs only on remote targets; use ${hostOs === "windows" ? "powershell" : "bash"} for local commands and ${osLabel[hostOs]} targets. Each call creates a new terminal session and returns its shell: source for inspection and interaction.`
          : `Use ${toolName} to execute a command in the user's configured shell. Each call creates a new terminal session and returns its shell: source for inspection and interaction.`,
        parameters: runParameters,
        outputSchema: shellOutputSchema,
        async execute(toolCallId, input, signal, onUpdate, context) {
          ui.bind(context);
          const origin = executionOrigin?.(toolCallId, context);
          const remote = targets.resolve(input.cwd ?? context.cwd, context.cwd);
          assertScope(scope, remote);
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
                shell: toolProfile,
              });
          // Set once at launch, including when the manager was retained from older code.
          session.origin ??= origin;
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
          const mode = context.expanded
            ? "full"
            : typeof presentation === "function"
              ? presentation()
              : presentation;
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
            remote ? remoteShellProfile(scope.targetOs) : toolProfile,
            theme,
          );
        },
        renderResult(result, options, theme) {
          return renderRunResult(
            result.details as Partial<TerminalSessionSnapshot>,
            options.expanded
              ? "full"
              : typeof presentation === "function"
                ? presentation()
                : presentation,
            theme,
          );
        },
      }),
    );
  }

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
