import path from "node:path";
import { access } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
import { debuggerSnapshotFromResult } from "#src/plugins/pi-agent-ide-debugger/src/ui.js";
import { debuggerProcessProvider } from "#src/plugins/pi-agent-ide-debugger/src/process-provider.js";
import { agentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";

interface DebugToolDetails {
  readonly source?: string;
  readonly sourceResource?: string;
  readonly breakpointsResource?: string;
  readonly adapter:
    | "dart"
    | "debugpy"
    | "delve"
    | "java"
    | "elixir"
    | "julia"
    | "kotlin"
    | "lldb-dap"
    | "lua"
    | "netcoredbg"
    | "node"
    | "php"
    | "powershell"
    | "r"
    | "ruby"
    | "shell";
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
  type DebugSession,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const debugParameters = Type.Object(
  {
    adapter: StringEnum(
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
          "Select an installed DAP adapter for Dart, Python, Go, Java, Elixir, Julia, Kotlin, C, C++, Rust, Swift, Zig, Lua, C#, JavaScript, TypeScript, PHP, PowerShell, R, Ruby, or shell scripts.",
      },
    ),
    program: Type.String({
      minLength: 1,
      description: "Source file or executable to launch. Relative paths resolve from cwd.",
    }),
    source: Type.Optional(
      Type.String({
        description: "Source file used for anchored breakpoints. Defaults to program.",
      }),
    ),
    args: Type.Optional(
      Type.Array(Type.String(), { description: "Arguments passed to the debugged program." }),
    ),
    mainClass: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Fully qualified JVM main class. Required by Java and Kotlin adapters.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory. Relative paths resolve from the workspace." }),
    ),
  },
  { additionalProperties: false },
);

/** Register agent-native debug sessions backed by Debug Adapter Protocol adapters. */
export default async function registerDebugger(pi: ExtensionAPI): Promise<void> {
  const manager =
    (takeReloadResource("debugger") as DebugSessionManager | undefined) ??
    new DebugSessionManager();
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
      api.describe(
        'views: ["breakpoints"] — show current debugger breakpoints beside source lines. On a normal file, all current sessions are included; on a debug source, results are session-scoped. debug:<session> — debugger state. Read the returned debug source before selecting a breakpoint line.',
      );
      api.addPromptGuideline(
        'Use views: ["breakpoints"] when current breakpoint locations matter. Create a debug session with debug. Read the returned debug source to get current anchors, insert text "breakpoint" at one source anchor, then insert "start" on the session. Use read for the latest stop and delete for a breakpoint or the session.',
      );
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "debugger",
    setup(api) {
      api.addResolver({ resolver: editorResolver });
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
              summary: `Breakpoint ${breakpoint.source} created at ${path.relative(session.options.cwd, breakpoint.file)}:${breakpoint.line}.`,
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
          await executeSessionCommand(manager, session, parameters.text, context.signal);
          return {
            source: session.source,
            summary: renderDebugSession(session),
            data: debugActionData(manager, session, parameters.text),
          };
        },
      });
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
        'For debug:<session> resources, insert performs debugger actions without changing source text. On a debug source, insert "breakpoint" at an anchor. On the session, insert start, continue, step over, step into, or step out. Delete removes a breakpoint or terminates the session.',
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
                  snapshot.breakpoints.find((candidate) => candidate.source === input.path));
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
            return renderDebugResult(snapshot, options.expanded, theme);
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
      label: "Debug session",
      promptSnippet: "Create a local DAP debug session before setting anchored breakpoints",
      description:
        "Use debug to create a configured local debugger session. This does not launch the program yet. The returned debug: resource survives extension reloads.",
      parameters: debugParameters,
      async execute(_toolCallId, input, _signal, _onUpdate, context) {
        const cwd = path.resolve(context.cwd, input.cwd ?? ".");
        const program = path.resolve(cwd, input.program);
        try {
          await access(program);
          const session = manager.create({
            adapter: input.adapter,
            program,
            sourceFile: path.resolve(cwd, input.source ?? input.program),
            args: input.args ?? [],
            cwd,
            ...(input.mainClass === undefined ? {} : { mainClass: input.mainClass }),
          });
          const details = debugDetails(manager, session);
          return {
            content: [
              {
                type: "text",
                text: `${renderDebugSession(session)}\nSource: ${details.sourceResource}\nBreakpoints: ${details.breakpointsResource}\n\nNext: read ${details.sourceResource} with views ["anchors"], then insert a breakpoint at an anchor.`,
              },
            ],
            details,
          };
        } catch (error) {
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
            details: { adapter: input.adapter, program, cwd, status: "failed" },
            isError: true,
          };
        }
      },
      renderCall(input, theme) {
        const cwd = path.resolve(process.cwd(), typeof input.cwd === "string" ? input.cwd : ".");
        const program = path.resolve(
          cwd,
          typeof input.program === "string" ? input.program : "program",
        );
        return renderDebugCall(
          typeof input.adapter === "string" ? input.adapter : "debugger",
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

  pi.on("session_shutdown", (event) => {
    removeProcessProvider();
    if (event.reason !== "quit") {
      retainReloadResource("debugger", manager);
      return;
    }
    forgetReloadResource("debugger", manager);
    manager.dispose();
  });
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
): Promise<void> {
  switch (command.trim().toLowerCase()) {
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
    snapshot: manager.snapshot(session),
  };
}

function renderBreakpointList(session: DebugSession): string {
  if (session.breakpoints.size === 0) return `No breakpoints in ${session.source}.`;
  return [...session.breakpoints.values()]
    .map(
      (breakpoint) =>
        `${breakpoint.verified ? "●" : "○"} ${breakpoint.file}:${breakpoint.line} · ${breakpoint.source}`,
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
