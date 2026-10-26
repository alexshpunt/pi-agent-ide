import path from "node:path";
import { access } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectAgentDocumentation, loadPackagedAgentGuide } from "pi-agent-documentation";
import { Type, type Static } from "typebox";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";
import type { ResourceResolver } from "pi-agent-resource";
import { resultError, structuredResultSchema, withStructuredResult } from "pi-agent-resource";
const debugDataSchema = Type.Object(
  {
    source: Type.String(),
    sourceResource: Type.String(),
    breakpointsResource: Type.String(),
    adapter: Type.String(),
    program: Type.String(),
    cwd: Type.String(),
    status: Type.String(),
    breakpoints: Type.Array(
      Type.Object(
        {
          source: Type.String(),
          file: Type.String(),
          line: Type.Integer(),
          verified: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const debugOutputSchema = structuredResultSchema(debugDataSchema);
import { toolCallHeader } from "pi-agent-tool-ui";

import {
  forgetReloadResource,
  retainReloadResource,
  takeReloadResource,
} from "#src/core/reload-resource-store.js";
import { debuggerDoctorPlugin } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.js";
import { createBreakpointPresenter } from "#src/plugins/pi-agent-ide-debugger/src/breakpoint-view.js";
import {
  renderDebugActionCall,
  renderDebugCall,
  renderDebugResult,
} from "#src/plugins/pi-agent-ide-debugger/src/renderer.js";
import {
  debuggerEvaluationFromResult,
  debuggerFailureFromResult,
  debuggerSnapshotFromResult,
} from "#src/plugins/pi-agent-ide-debugger/src/ui.js";
import { debuggerProcessProvider } from "#src/plugins/pi-agent-ide-debugger/src/process-provider.js";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import type { DebugWorkspaceOwnerResolver } from "./src/workspace-owner.js";
import { VscodeDebugSession } from "./src/vscode-backend.js";

interface DebugToolDetails {
  readonly source?: string;
  readonly sourceResource?: string;
  readonly breakpointsResource?: string;
  /** Native adapter, `vscode`, or the requested backend when creation failed. */
  readonly adapter: string;
  readonly program: string;
  readonly sourceFile?: string;
  readonly cwd: string;
  readonly status: string;
  readonly breakpoints?: readonly unknown[];
  readonly stop?: unknown;
  readonly snapshot?: unknown;
}

import {
  DebugSessionManager,
  renderDebugSession,
  type DebugEvaluation,
  type DebugSession,
  type DebugSessionOptions,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const debugParameters = Type.Object(
  {
    backend: Type.Optional(
      StringEnum(["auto", "vscode", "native"] as const, {
        description:
          "Select the debugger backend. auto (default) debugs through VS Code when the local program is inside a workspace open in VS Code with the DebugMCP extension, that window has no active debug session, and args and mainClass are omitted; otherwise it uses the native adapter. vscode fails with the unmet condition instead of falling back. native always launches the selected adapter.",
      }),
    ),
    adapter: Type.Optional(
      StringEnum(
        [
          "dart",
          "debugpy",
          "delve",
          "java",
          "elixir",
          "julia",
          "kotlin",
          "lldb-dap",
          "lua",
          "netcoredbg",
          "node",
          "php",
          "powershell",
          "r",
          "ruby",
          "shell",
        ] as const,
        {
          description:
            "Select an installed native DAP adapter for Dart, Python, Go, Java, Elixir, Julia, Kotlin, C, C++, Rust, Swift, Zig, Lua, C#, JavaScript, TypeScript, PHP, PowerShell, R, Ruby, or shell scripts. Required for the native backend; VS Code chooses its debugger from launch.json or the file type.",
        },
      ),
    ),
    program: Type.String({
      minLength: 1,
      description: "Source file or executable to launch. Relative paths resolve from cwd.",
    }),
    source: Type.Optional(
      Type.String({
        description:
          "Source file used for anchored breakpoints. Defaults to program. Relative paths resolve from cwd.",
      }),
    ),
    args: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Arguments passed to the debugged program by the native backend. For VS Code, put them in a launch.json configuration.",
      }),
    ),
    mainClass: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Fully qualified JVM main class. Required by Java and Kotlin adapters.",
      }),
    ),
    configuration: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Name of a .vscode/launch.json configuration to launch in VS Code. Use it for program arguments or environment. VS Code backend only.",
      }),
    ),
    test: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Name of one test to debug through the VS Code Testing API; set program to its test file. VS Code backend only.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Select a local working directory or ssh://target/absolute/path. Relative paths resolve from the workspace.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Bind configuration and source ownership without probing unrelated targets. */
export interface DebuggerWorkspaceAccess {
  readonly workspace: DebugWorkspaceOwnerResolver;
  /** Resolve explicitly owned inputs; leave controller-local inputs to the local adapter. */
  resolveOptions(
    input: Static<typeof debugParameters>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<DebugSessionOptions | undefined>;
}

/** Register standalone controller-local Debug Adapter Protocol sessions. */
export default function registerDebugger(pi: ExtensionAPI): Promise<void> {
  return registerDebuggerWithOwner(pi);
}

/** Register ordinary debugger resources with an optional explicitly owned workspace backend. */
export async function registerDebuggerWithOwner(
  pi: ExtensionAPI,
  ownerAccess?: DebuggerWorkspaceAccess,
): Promise<void> {
  connectAgentDocumentation(pi, [
    await loadPackagedAgentGuide({
      id: "debugger",
      description: "Debugger sessions, breakpoints, stepping, and cleanup",
      triggers: [
        { tool: "debug" },
        ...["read", "insert", "delete"].map((tool) => ({ tool, resourcePrefixes: ["debug:"] })),
      ],
    }),
  ]);
  const manager = takeReloadResource("debugger", DebugSessionManager) ?? new DebugSessionManager();
  manager.setOwnerResolver(ownerAccess?.workspace);
  const deletedSnapshots = new Map<string, ReturnType<DebugSessionManager["snapshot"]>>();
  const readResolver = createDebugResourceResolver(manager, "debugger-source");
  const editorResolver = createDebugResourceResolver(manager, "debugger-input");
  const removeProcessProvider = agentIdeProcessRegistry(pi).add(debuggerProcessProvider(manager));
  const breakpointPresenter = createBreakpointPresenter(manager);
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "debugger",
    setup(api) {
      api.addResolver({
        resolver: readResolver,
        matchesCall: (source) => manager.sourceFile(source) !== undefined,
        renderCall(arguments_, theme, context) {
          const input = isRecord(arguments_) ? arguments_ : {};
          const source = typeof input.path === "string" ? input.path : "";
          const session = manager.get(source);
          const sourceFile = manager.sourceFile(source);
          if (session === undefined || sourceFile === undefined) {
            throw new Error("Debugger source header lost its session");
          }
          const relative = path.relative(session.options.cwd, sourceFile);
          const views = Array.isArray(input.views)
            ? input.views.filter((view): view is string => typeof view === "string")
            : [];
          const offset = typeof input.offset === "number" ? input.offset : 1;
          const limit = typeof input.limit === "number" ? input.limit : undefined;
          const range = limit === undefined ? String(offset) : `${offset}-${offset + limit - 1}`;
          return toolCallHeader(
            context.lastComponent,
            {
              tool: "debug file",
              primary: { text: `${relative}:${range}`, color: "accent", underline: true },
              qualifiers: views.length === 0 ? [] : [{ text: `views ${views.join(",")}` }],
              details: [
                { label: "source", value: source },
                { label: "file", value: sourceFile },
                ...(views.length === 0 ? [] : [{ label: "views", value: views.join(",") }]),
              ],
              expanded: context.expanded,
            },
            theme,
          );
        },
      });
      api.addView({ view: "breakpoints", presenter: breakpointPresenter });
      api.describe({
        path: "debug:<session> — debugger state.",
        views: "breakpoints — breakpoints beside the lines.",
      });
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "debugger",
    setup(api) {
      api.addResolver({ resolver: editorResolver });
      api
        .tool("insert")
        .describeField(
          "path",
          "debug:<session> controls the debugger; debug:<session>/source with a line anchor sets a breakpoint.",
        );
      api
        .tool("insert")
        .describeField(
          "text",
          "For debug:<session>: start, continue, step over, step into, step out or evaluate <expression> (needs a stopped frame). For debug:<session>/source: breakpoint.",
        );
      api.tool("insert").describeField("anchor", "Omit for debug:<session>.");
      api.tool("insert").addSemanticHandler({
        matches: (input) => matchesDebugInsert(input, manager),
        execute: async (context, input) => {
          const parameters = input as {
            readonly path: string;
            readonly anchor?: string;
            readonly text: string;
          };
          const session = requiredSession(manager, parameters.path);
          if (manager.sourceFile(parameters.path) !== undefined) {
            if (parameters.text !== "breakpoint" || parameters.anchor === undefined) {
              throw new Error('A debug source accepts text "breakpoint" with one anchor');
            }
            const anchor = await context.resolveAnchor("anchor");
            const breakpoint = await manager.addBreakpoint(
              parameters.path,
              anchor.lineNumber,
              context.signal,
            );
            return {
              source: breakpoint.source,
              summary: `Breakpoint ${breakpoint.source} registered at ${path.relative(session.options.cwd, breakpoint.file)}:${breakpoint.line} (${breakpoint.verified ? "verified" : "pending"}).`,
              data: {
                kind: "debug-breakpoint",
                session: session.source,
                file: breakpoint.file,
                line: breakpoint.line,
                verified: breakpoint.verified,
                snapshot: manager.snapshot(session),
              },
            };
          }
          if (parameters.path !== session.source || parameters.anchor !== undefined) {
            throw new Error("Debug commands target the session resource without an anchor");
          }
          let evaluation: DebugEvaluation | undefined;
          try {
            evaluation = await executeSessionCommand(
              manager,
              session,
              parameters.text,
              context.signal,
            );
          } catch (error) {
            // Return the debugger's own reason with the session state instead of a generic edit failure.
            if (context.signal?.aborted === true) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return {
              source: session.source,
              summary: `${parameters.text.trim()} failed: ${message}\n\n${renderDebugSession(session)}`,
              data: {
                ...debugActionData(manager, session, parameters.text),
                ok: false,
                effect: "not-applied",
                error: { code: "DEBUG_ACTION_FAILED", message },
              },
            };
          }
          return {
            source: session.source,
            summary:
              evaluation === undefined
                ? renderDebugSession(session)
                : `${evaluation.expression} = ${evaluation.result}${evaluation.type === undefined ? "" : ` (${evaluation.type})`}`,
            data: debugActionData(manager, session, parameters.text, evaluation),
          };
        },
      });
      api
        .tool("delete")
        .describeField(
          "path",
          "debug:<session> ends it; debug:<session>/breakpoint/<id> removes a breakpoint.",
        );
      api.tool("delete").addSemanticHandler({
        matches: (input) => matchesDebugDelete(input, manager),
        execute: async (context, input) => {
          const source = (input as { readonly path: string }).path;
          const session = requiredSession(manager, source);
          const before = manager.snapshot(session);
          deletedSnapshots.set(source, before);
          const deletingBreakpoint = source.includes("/breakpoint/");
          await manager.delete(source, context.signal);
          const snapshot = deletingBreakpoint
            ? manager.snapshot(session)
            : { ...before, status: "terminated" as const };
          return {
            source,
            summary: `Deleted ${source}.`,
            data: {
              kind: deletingBreakpoint ? "debug-breakpoint" : "debug-session",
              deleted: true,
              snapshot,
            },
          };
        },
      });
      api.describe(
        'For debug:<session> resources, insert performs debugger actions without changing source text. On a debug source, insert "breakpoint" at an anchor. On the session, insert start, continue, step over, step into, step out, or evaluate <expression>. Delete removes a breakpoint or terminates the session.',
      );
      for (const tool of ["insert", "delete"] as const) {
        api.addToolRenderer({
          tool,
          matches(value, phase) {
            if (phase === "call") {
              return (
                isRecord(value) &&
                typeof value.path === "string" &&
                (manager.get(value.path) !== undefined || deletedSnapshots.has(value.path))
              );
            }
            return (
              debuggerSnapshotFromResult(
                isRecord(value) && "details" in value ? value.details : value,
              ) !== undefined
            );
          },
          renderCall(arguments_, theme, context) {
            const input = arguments_ as { readonly path?: string; readonly text?: string };
            const session = input.path === undefined ? undefined : manager.get(input.path);
            const deletedSnapshot =
              input.path === undefined ? undefined : deletedSnapshots.get(input.path);
            const state = context.state as {
              snapshot?: ReturnType<DebugSessionManager["snapshot"]>;
            };
            if (session !== undefined) state.snapshot = manager.snapshot(session);
            else if (deletedSnapshot !== undefined) state.snapshot = deletedSnapshot;
            const snapshot = state.snapshot;
            if (snapshot === undefined) throw new Error("Debugger renderer lost its session");
            const breakpoint =
              input.path === undefined
                ? undefined
                : (manager.breakpoint(input.path) ??
                  (deletedSnapshot ?? snapshot).breakpoints.find(
                    (candidate) => candidate.source === input.path,
                  ));
            const sourceFile =
              input.path === undefined ? undefined : manager.sourceFile(input.path);
            const action =
              tool === "delete"
                ? breakpoint === undefined
                  ? "delete-session"
                  : `delete-breakpoint ${path.basename(breakpoint.file)}:${breakpoint.line}`
                : input.text === "breakpoint" && sourceFile !== undefined
                  ? `breakpoint ${path.basename(sourceFile)}:${breakpointLine(input)}`
                  : (input.text ?? "debug action");
            return renderDebugActionCall(snapshot, action, theme);
          },
          renderResult(result, options, theme) {
            const snapshot = debuggerSnapshotFromResult(result.details);
            if (snapshot === undefined) throw new Error("Debugger result is missing its session");
            const evaluation = debuggerEvaluationFromResult(result.details);
            return renderDebugResult(
              snapshot,
              options.expanded,
              theme,
              evaluation,
              debuggerFailureFromResult(result.details),
            );
          },
        });
      }
    },
  } satisfies TextEditorPlugin;

  await Promise.all([
    connectDoctorPlugin(pi, debuggerDoctorPlugin),
    connectReadPlugin(pi, readPlugin),
  ]);
  await connectTextEditorPlugin(pi, editorPlugin);

  pi.registerTool(
    defineTool<typeof debugParameters, DebugToolDetails>({
      name: "debug",
      exposure: "deferred",
      namespace: {
        name: "ide_debug",
        description: "Create debugger sessions and inspect debug resources.",
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      label: "Debug session",
      promptSnippet: "Configure a local debugger session",
      description:
        "Use debug to create a configured debugger session on a local or supported SSH workspace, through VS Code or a native adapter. This does not launch the program yet. The returned debug: resource survives extension reloads.",
      parameters: debugParameters,
      outputSchema: debugOutputSchema,
      async execute(_toolCallId, input, signal, _onUpdate, context) {
        const backend = input.backend ?? "auto";
        let cwd = input.cwd ?? context.cwd;
        let program = input.program;
        try {
          signal?.throwIfAborted();
          if (
            backend === "vscode" &&
            [input.cwd, input.program, input.source].some((source) => source?.includes("://"))
          ) {
            throw new Error("The VS Code backend debugs only local workspaces");
          }
          const owned = await ownerAccess?.resolveOptions(input, context.cwd, signal);
          if (
            owned === undefined &&
            [cwd, program, input.source].some((source) => source?.includes("://"))
          ) {
            throw new Error(`No debugger workspace owner: ${program}`);
          }
          cwd = owned?.cwd ?? path.resolve(context.cwd, input.cwd ?? ".");
          program = owned?.program ?? path.resolve(cwd, input.program);
          if (owned === undefined) await access(program);
          signal?.throwIfAborted();
          const sourceFile = path.resolve(cwd, input.source ?? input.program);
          const selection =
            owned === undefined && backend !== "native"
              ? await openVscodeBackend(backend, input, { cwd, program, sourceFile }, signal)
              : { unavailable: "native backend requested" };
          let session: DebugSession;
          if ("vscode" in selection) {
            session = manager.create(
              {
                adapter: "vscode",
                program,
                sourceFile,
                args: [],
                cwd,
                ...(input.configuration === undefined
                  ? {}
                  : { configuration: input.configuration }),
                ...(input.test === undefined ? {} : { test: input.test }),
              },
              selection.vscode,
            );
          } else if (input.configuration !== undefined || input.test !== undefined) {
            throw new Error("configuration and test need the VS Code backend");
          } else if (owned !== undefined) {
            session = manager.create(owned);
          } else if (input.adapter === undefined) {
            throw new Error(
              `Select an adapter for the native debugger backend. VS Code is not used: ${selection.unavailable}`,
            );
          } else {
            session = manager.create({
              adapter: input.adapter,
              program,
              sourceFile,
              args: input.args ?? [],
              cwd,
              ...(input.mainClass === undefined ? {} : { mainClass: input.mainClass }),
            });
          }
          const details = debugDetails(manager, session);
          const { snapshot: _snapshot, stop: _stop, ...data } = details;
          return withStructuredResult(
            {
              content: [
                {
                  type: "text",
                  text: `${renderDebugSession(session)}\nSource: ${details.sourceResource}\nBreakpoints: ${details.breakpointsResource}\n\nNext: read ${session.source} to inspect the configured session. To set a breakpoint, read ${details.sourceResource} with views ["anchors"], then insert "breakpoint" at an anchor.`,
                },
              ],
              details,
            },
            debugDataSchema,
            { status: "success", data, errors: [] },
          );
        } catch (error) {
          return withStructuredResult(
            {
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              details: { adapter: input.adapter ?? backend, program, cwd, status: "failed" },
              isError: true,
            },
            debugDataSchema,
            { status: "error", errors: [resultError(error, "DEBUG_SESSION_FAILED", program)] },
          );
        }
      },
      renderCall(input, theme) {
        const rawCwd = typeof input.cwd === "string" ? input.cwd : ".";
        const rawProgram = typeof input.program === "string" ? input.program : "program";
        const cwd = rawCwd.startsWith("ssh://") ? rawCwd : path.resolve(process.cwd(), rawCwd);
        const program =
          rawProgram.startsWith("ssh://") || cwd.startsWith("ssh://")
            ? rawProgram
            : path.resolve(cwd, rawProgram);
        return renderDebugCall(
          typeof input.adapter === "string"
            ? input.adapter
            : input.backend === "vscode"
              ? "vscode"
              : "debugger",
          program,
          cwd,
          theme,
        );
      },
      renderResult(result, options, theme) {
        const snapshot = isRecord(result.details) ? result.details.snapshot : undefined;
        if (typeof snapshot === "object" && snapshot !== null) {
          return renderDebugResult(
            snapshot as ReturnType<DebugSessionManager["snapshot"]>,
            options.expanded,
            theme,
          );
        }
        const details = result.details;
        return renderDebugCall(details.adapter, details.program, details.cwd, theme);
      },
    }),
  );

  pi.on("session_shutdown", async (event) => {
    removeProcessProvider();
    if (event.reason !== "quit") {
      retainReloadResource("debugger", manager);
      return;
    }
    forgetReloadResource("debugger", manager);
    await manager.dispose();
  });
}

/** Open the VS Code backend, or report why auto mode falls back to the native adapter. */
async function openVscodeBackend(
  backend: "auto" | "vscode",
  input: Static<typeof debugParameters>,
  paths: { readonly cwd: string; readonly program: string; readonly sourceFile: string },
  signal?: AbortSignal,
): Promise<{ readonly vscode: VscodeDebugSession } | { readonly unavailable: string }> {
  try {
    const unsupported =
      (input.args?.length ?? 0) > 0
        ? "args"
        : input.mainClass === undefined
          ? undefined
          : "mainClass";
    if (unsupported !== undefined) {
      throw new Error(`it does not accept ${unsupported}; use a launch.json configuration`);
    }
    return { vscode: await VscodeDebugSession.open(paths, signal) };
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    if (backend === "vscode" || input.configuration !== undefined || input.test !== undefined) {
      throw new Error(`VS Code backend unavailable: ${reason}`, { cause: error });
    }
    return { unavailable: reason };
  }
}

function createDebugResourceResolver(manager: DebugSessionManager, id: string): ResourceResolver {
  return {
    id,
    tryResolve(source) {
      const session = manager.get(source);
      if (session === undefined) return Promise.resolve({ kind: "not-handled" });
      return Promise.resolve({
        kind: "resolved",
        resource: {
          source,
          async read() {
            await manager.refresh(session);
            const sourceFile = manager.sourceFile(source);
            if (sourceFile !== undefined) {
              return [debugSourceContent(sourceFile, await manager.readSource(source))];
            }
            if (source === `${session.source}/breakpoints`) {
              return [{ type: "text" as const, text: renderBreakpointList(session) }];
            }
            const breakpoint = manager.breakpoint(source);
            if (source !== session.source && breakpoint === undefined) {
              throw new Error(`Unknown debug resource ${source}`);
            }
            const text =
              breakpoint === undefined
                ? renderDebugSession(session)
                : `Breakpoint: ${breakpoint.source}\nFile: ${breakpoint.file}\nLine: ${breakpoint.line}\nStatus: ${breakpoint.verified ? "verified" : "pending"}`;
            return [{ type: "text" as const, text }];
          },
        },
      });
    },
  };
}

function matchesDebugInsert(input: unknown, manager: DebugSessionManager): boolean {
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.text !== "string")
    return false;
  const session = manager.get(input.path);
  return (
    session !== undefined &&
    (input.path === session.source || manager.sourceFile(input.path) !== undefined)
  );
}

function matchesDebugDelete(input: unknown, manager: DebugSessionManager): boolean {
  if (!isRecord(input) || typeof input.path !== "string") return false;
  const session = manager.get(input.path);
  return (
    session !== undefined &&
    (input.path === session.source || input.path.startsWith(`${session.source}/breakpoint/`))
  );
}

async function executeSessionCommand(
  manager: DebugSessionManager,
  session: DebugSession,
  command: string,
  signal?: AbortSignal,
): Promise<DebugEvaluation | undefined> {
  const trimmed = command.trim();
  const evaluation = /^evaluate\s+(.+)$/isu.exec(trimmed);
  if (evaluation !== null) {
    return await manager.evaluate(session, evaluation[1] as string, signal);
  }
  switch (trimmed.toLowerCase()) {
    case "start": {
      await manager.start(session, signal);
      return;
    }
    case "continue": {
      await manager.command(session, "continue", signal);
      return;
    }
    case "step over": {
      await manager.command(session, "next", signal);
      return;
    }
    case "step into": {
      await manager.command(session, "stepIn", signal);
      return;
    }
    case "step out": {
      await manager.command(session, "stepOut", signal);
      return;
    }
    default: {
      throw new Error(`Unknown debug command ${JSON.stringify(command)}`);
    }
  }
}

function debugDetails(manager: DebugSessionManager, session: DebugSession) {
  return {
    source: session.source,
    sourceResource: manager.sourceResource(session),
    breakpointsResource: `${session.source}/breakpoints`,
    adapter: session.options.adapter,
    program: session.options.program,
    cwd: session.options.cwd,
    status: session.status,
    breakpoints: [...session.breakpoints.values()].map(({ source, file, line, verified }) => ({
      source,
      file,
      line,
      verified,
    })),
    ...(session.stop === undefined ? {} : { stop: session.stop }),
    snapshot: manager.snapshot(session),
  };
}

function debugActionData(
  manager: DebugSessionManager,
  session: DebugSession,
  command: string,
  evaluation?: DebugEvaluation,
): Readonly<Record<string, unknown>> {
  return {
    kind: "debug-command",
    command,
    status: session.status,
    breakpoints: [...session.breakpoints.values()].map(({ source, file, line, verified }) => ({
      source,
      file,
      line,
      verified,
    })),
    ...(session.stop === undefined ? {} : { stop: session.stop }),
    ...(evaluation === undefined ? {} : { evaluation }),
    snapshot: manager.snapshot(session),
  };
}

function renderBreakpointList(session: DebugSession): string {
  if (session.breakpoints.size === 0) return `No breakpoints in ${session.source}.`;
  return [...session.breakpoints.values()]
    .map(
      (breakpoint) =>
        `${breakpoint.verified ? "●" : "○"} ${breakpoint.file}:${breakpoint.line} · ${breakpoint.source} (${breakpoint.verified ? "verified" : "pending"})`,
    )
    .join("\n");
}

function requiredSession(manager: DebugSessionManager, source: string): DebugSession {
  const session = manager.get(source);
  if (session === undefined) throw new Error(`Unknown debug session ${source}`);
  return session;
}

function breakpointLine(input: unknown): string {
  const anchor = isRecord(input) && typeof input.anchor === "string" ? input.anchor : undefined;
  const match = /^(\d+)#/u.exec(anchor ?? "");
  return match?.[1] ?? anchor ?? "selected line";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function debugSourceContent(sourceFile: string, text: string) {
  return {
    type: "text" as const,
    text,
    sourceLines: Object.fromEntries(
      text
        .split(/\r?\n/u)
        .map((line, index) => [
          String(index + 1),
          { source: sourceFile, lineNumber: index + 1, content: line },
        ]),
    ),
  };
}
