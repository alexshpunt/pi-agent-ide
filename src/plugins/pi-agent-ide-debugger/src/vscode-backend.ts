import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { DebugMcpClient } from "./debugmcp-client.js";

/** Marketplace identity of the DebugMCP VS Code extension. */
export const DEBUGMCP_EXTENSION_ID = "ozzafar.debugmcpextension";
/** DebugMCP port: `PI_DEBUGMCP_PORT` when VS Code changed `debugmcp.serverPort`, else its default. */
export function debugMcpPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PI_DEBUGMCP_PORT ?? 3001);
}
/** DebugMCP treats window registrations older than this as stale. */
const STALE_REGISTRATION_MS = 60_000;
/** Wait for the next stop as long as the native backend does. */
const STOP_WAIT_SECONDS = 30;

/** A running VS Code window that advertises DebugMCP for its workspace folders. */
export interface VscodeWindow {
  readonly pid: number;
  readonly name: string;
  readonly workspaceFolders: readonly string[];
}

/** Active debug session state of the routed VS Code window. */
export interface VscodeDebugState {
  readonly status: "no-session" | "running" | "paused";
  readonly configurationName?: string;
  readonly frame?: {
    readonly id: number;
    readonly threadId: number;
    readonly name: string;
    readonly file: string;
    readonly line: number;
  };
}

/** Local value of one variable in the paused VS Code frame. */
export interface VscodeVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
}

/** Launch choices DebugMCP resolves inside VS Code. */
export interface VscodeLaunch {
  readonly program: string;
  readonly cwd: string;
  /** Name of a `.vscode/launch.json` configuration. */
  readonly configuration?: string;
  /** Test name launched through the VS Code Testing API. */
  readonly test?: string;
}

type VscodeCommand = "continue" | "next" | "stepIn" | "stepOut";

const COMMAND_TOOLS: Readonly<Record<VscodeCommand, string>> = {
  continue: "continue_execution",
  next: "step_over",
  stepIn: "step_into",
  stepOut: "step_out",
};

/** Find a live DebugMCP window whose workspace folders contain every path. */
export async function findVscodeWindow(
  paths: readonly string[],
): Promise<VscodeWindow | undefined> {
  for (const directory of registryDirectories()) {
    const files = await readdir(directory).catch(() => []);
    for (const file of files) {
      if (!/^window-\d+\.json$/u.test(file)) continue;
      const window = await readRegistration(path.join(directory, file));
      if (
        window !== undefined &&
        paths.every((target) => window.workspaceFolders.some((folder) => isInside(target, folder)))
      ) {
        return window;
      }
    }
  }
  return undefined;
}

/** Report whether the DebugMCP extension is installed in a local or WSL VS Code. */
export async function debugMcpInstalled(): Promise<boolean> {
  for (const directory of [
    path.join(homedir(), ".vscode-server", "extensions"),
    path.join(homedir(), ".vscode", "extensions"),
  ]) {
    const entries = await readdir(directory).catch(() => []);
    if (entries.some((entry) => entry.startsWith(`${DEBUGMCP_EXTENSION_ID}-`))) return true;
  }
  return false;
}

/** Check that DebugMCP accepts MCP sessions on its port. */
export async function debugMcpResponds(signal?: AbortSignal): Promise<boolean> {
  try {
    await (await DebugMcpClient.connect(debugMcpPort(), signal)).close();
    return true;
  } catch {
    return false;
  }
}

/** One Pi debug session driven through a DebugMCP-routed VS Code window. */
export class VscodeDebugSession {
  readonly window: VscodeWindow;
  readonly #client: DebugMcpClient;
  /** Pi breakpoint count per VS Code location created by this session. */
  readonly #ownedBreakpoints = new Map<string, number>();
  #configurationName: string | undefined;

  private constructor(window: VscodeWindow, client: DebugMcpClient) {
    this.window = window;
    this.#client = client;
  }

  /** Connect when VS Code can debug these paths, or throw the unmet condition. */
  static async open(
    paths: { readonly cwd: string; readonly program: string; readonly sourceFile: string },
    signal?: AbortSignal,
  ): Promise<VscodeDebugSession> {
    const window = await findVscodeWindow([paths.cwd, paths.program, paths.sourceFile]);
    if (window === undefined) {
      throw new Error(`No running VS Code window with DebugMCP has ${paths.cwd} open`);
    }
    const port = debugMcpPort();
    let client: DebugMcpClient;
    try {
      client = await DebugMcpClient.connect(port, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`DebugMCP did not respond on port ${port}: ${message(error)}`, {
        cause: error,
      });
    }
    const session = new VscodeDebugSession(window, client);
    try {
      // This path-bearing no-op routes the MCP session to the window that owns the program.
      await client.call("remove_breakpoint", { fileFullPath: paths.program, line: 0 }, signal);
      if ((await session.status(0, signal)).status !== "no-session") {
        throw new Error(`VS Code window "${window.name}" already has an active debug session`);
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    return session;
  }

  /** Add a VS Code breakpoint unless one already exists at that location. */
  async addBreakpoint(file: string, line: number, signal?: AbortSignal): Promise<void> {
    const key = `${file}:${line}`;
    const owned = this.#ownedBreakpoints.get(key);
    if (owned !== undefined) {
      this.#ownedBreakpoints.set(key, owned + 1);
      return;
    }
    // DebugMCP removes every breakpoint at a location, so reuse a user's breakpoint instead.
    const listed = await this.#client.call("list_breakpoints", {}, signal);
    if (listedBreakpoints(listed).has(`${path.basename(file)}:${line}`)) return;
    await this.#client.call("add_breakpoint", { fileFullPath: file, line }, signal);
    this.#ownedBreakpoints.set(key, 1);
  }

  /** Remove a breakpoint only after the last Pi breakpoint that created it is gone. */
  async removeBreakpoint(file: string, line: number, signal?: AbortSignal): Promise<void> {
    const key = `${file}:${line}`;
    const owned = this.#ownedBreakpoints.get(key);
    if (owned === undefined) return;
    if (owned > 1) {
      this.#ownedBreakpoints.set(key, owned - 1);
      return;
    }
    this.#ownedBreakpoints.delete(key);
    await this.#client.call("remove_breakpoint", { fileFullPath: file, line }, signal);
  }

  /** Launch the program in VS Code and return the state it reached. */
  async start(launch: VscodeLaunch, signal?: AbortSignal): Promise<VscodeDebugState> {
    await this.#client.call(
      "start_debugging",
      {
        fileFullPath: launch.program,
        workingDirectory: launch.cwd,
        ...(launch.configuration === undefined ? {} : { configurationName: launch.configuration }),
        ...(launch.test === undefined ? {} : { testName: launch.test }),
      },
      signal,
    );
    const state = await this.status(0, signal);
    this.#configurationName = state.configurationName;
    return state;
  }

  /** Continue or step, then wait for the next stop or termination. */
  async command(command: VscodeCommand, signal?: AbortSignal): Promise<VscodeDebugState> {
    await this.#client.call(COMMAND_TOOLS[command], {}, signal);
    return this.status(STOP_WAIT_SECONDS, signal);
  }

  /** Read the routed window's debug state, optionally waiting for a pause. */
  async status(waitSeconds: number, signal?: AbortSignal): Promise<VscodeDebugState> {
    const text = await this.#client.call(
      "get_debug_status",
      waitSeconds === 0 ? {} : { waitForPauseSeconds: waitSeconds },
      signal,
    );
    return debugState(JSON.parse(text) as Readonly<Record<string, unknown>>);
  }

  /** Read local variables of the paused frame. */
  async locals(signal?: AbortSignal): Promise<readonly VscodeVariable[]> {
    const names = variableNames(
      await this.#client.call("list_variable_names", { scope: "local" }, signal),
    ).slice(0, 50);
    if (names.length === 0) return [];
    const values = await this.#client.call(
      "get_variables_values",
      { variableNames: names.map(({ name }) => name), scope: "local" },
      signal,
    );
    return variableValues(values, names);
  }

  /** Evaluate an expression in the paused frame. */
  async evaluate(
    expression: string,
    signal?: AbortSignal,
  ): Promise<{ readonly result: string; readonly type?: string }> {
    return evaluation(await this.#client.call("evaluate_expression", { expression }, signal));
  }

  /** Remove Pi breakpoints, stop the session Pi started, and end the MCP session. */
  async close(signal?: AbortSignal): Promise<void> {
    try {
      for (const key of this.#ownedBreakpoints.keys()) {
        const separator = key.lastIndexOf(":");
        await this.#client.call(
          "remove_breakpoint",
          { fileFullPath: key.slice(0, separator), line: Number(key.slice(separator + 1)) },
          signal,
        );
      }
      this.#ownedBreakpoints.clear();
      const state = await this.status(0, signal);
      // Never stop a session that the user started after Pi's session ended.
      if (state.status !== "no-session" && state.configurationName === this.#configurationName) {
        await this.#client.call("stop_debugging", {}, signal);
      }
    } finally {
      await this.#client.close();
    }
  }
}

function registryDirectories(): string[] {
  const home = homedir();
  return [
    path.join(home, ".vscode-server", "data", "User"),
    path.join(home, ".config", "Code", "User"),
    path.join(home, "Library", "Application Support", "Code", "User"),
    ...(process.env.APPDATA === undefined ? [] : [path.join(process.env.APPDATA, "Code", "User")]),
  ].map((root) => path.join(root, "globalStorage", DEBUGMCP_EXTENSION_ID, "window-registry"));
}

async function readRegistration(file: string): Promise<VscodeWindow | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as Readonly<Record<string, unknown>>;
    if (
      typeof entry.pid !== "number" ||
      typeof entry.updatedAt !== "number" ||
      !Array.isArray(entry.workspaceFolders) ||
      Date.now() - entry.updatedAt > STALE_REGISTRATION_MS ||
      !processAlive(entry.pid)
    ) {
      return undefined;
    }
    return {
      pid: entry.pid,
      name: typeof entry.name === "string" ? entry.name : "",
      workspaceFolders: entry.workspaceFolders.filter(
        (folder): folder is string => typeof folder === "string",
      ),
    };
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isInside(target: string, folder: string): boolean {
  const base = path.resolve(folder);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

function debugState(raw: Readonly<Record<string, unknown>>): VscodeDebugState {
  const status =
    raw.status === "paused" || raw.status === "running" ? raw.status : ("no-session" as const);
  const configurationName =
    typeof raw.configurationName === "string" ? raw.configurationName : undefined;
  const state =
    typeof raw.state === "object" && raw.state !== null
      ? (raw.state as Readonly<Record<string, unknown>>)
      : {};
  const frame =
    typeof state.fileFullPath === "string" && typeof state.currentLine === "number"
      ? {
          id: typeof state.frameId === "number" ? state.frameId : 0,
          threadId: typeof state.threadId === "number" ? state.threadId : 0,
          name: typeof state.frameName === "string" ? state.frameName : "",
          file: state.fileFullPath,
          line: state.currentLine,
        }
      : undefined;
  return {
    status,
    ...(configurationName === undefined ? {} : { configurationName }),
    ...(status === "paused" && frame !== undefined ? { frame } : {}),
  };
}

/** Parse `N. Breakpoint name:line` entries of `list_breakpoints`. */
function listedBreakpoints(text: string): ReadonlySet<string> {
  return new Set(
    text.split(/\r?\n/u).flatMap((line) => {
      const match = /^\d+\. (?:Breakpoint|Logpoint) (.+?):(\d+)(?: \(|$)/u.exec(line);
      return match === null ? [] : [`${match[1]}:${match[2]}`];
    }),
  );
}

/** Parse two-space-indented `name (type)` entries of `list_variable_names`. */
function variableNames(text: string): { readonly name: string; readonly type?: string }[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const match = /^ {2}(\S.*?)(?: \(([^()]*)\))?$/u.exec(line);
    if (
      match === null ||
      /^(?:No variables in this scope|Error retrieving variables:)/u.test(line.trim())
    )
      return [];
    const name = match[1];
    const type = match[2];
    if (name === undefined) return [];
    return [{ name, ...(type === undefined ? {} : { type }) }];
  });
}

/** Match `get_variables_values` top-level lines to the listed names; aggregates have no value. */
function variableValues(
  text: string,
  names: readonly { readonly name: string; readonly type?: string }[],
): VscodeVariable[] {
  const lines = text.split(/\r?\n/u);
  return names.flatMap(({ name, type }) => {
    const prefix = `  ${name}`;
    const line = lines.find(
      (candidate) =>
        candidate === prefix ||
        candidate.startsWith(`${prefix}: `) ||
        candidate.startsWith(`${prefix} (`),
    );
    if (line === undefined) return [];
    const rest = line.slice(prefix.length);
    const typeSuffix = type === undefined ? undefined : ` (${type})`;
    let value = rest.startsWith(": ") ? rest.slice(2) : "<complex value>";
    if (typeSuffix !== undefined && value.endsWith(typeSuffix))
      value = value.slice(0, -typeSuffix.length);
    return [{ name, value, ...(type === undefined ? {} : { type }) }];
  });
}

/** Parse `Result: value (type)` and expanded child lines of `evaluate_expression`. */
function evaluation(text: string): { readonly result: string; readonly type?: string } {
  const lines = text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith("Result: "));
  const match = /^Result: (.*?)(?: \(([^()]*)\))?$/u.exec(lines[index] ?? "");
  if (match === null) throw new Error(`DebugMCP returned no evaluation result: ${text}`);
  const children = lines.slice(index + 1).filter((line) => line.startsWith("  "));
  return {
    result: [match[1] as string, ...children].join("\n"),
    ...(match[2] === undefined ? {} : { type: match[2] }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
