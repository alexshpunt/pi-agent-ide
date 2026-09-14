import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DapClient,
  type DapEvent,
  type DapReverseRequest,
} from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";

export type DebugSessionStatus = "configured" | "running" | "stopped" | "terminated";

/** Adapter identifiers accepted by agent-native debug sessions. */
export type DebugAdapter =
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

export interface DebugSessionOptions {
  readonly adapter: DebugAdapter;
  readonly program: string;
  readonly sourceFile: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly mainClass?: string;
}

export interface DebugBreakpoint {
  readonly id: string;
  readonly source: string;
  readonly file: string;
  readonly line: number;
  verified: boolean;
}

export interface DebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variablesReference: number;
}

export interface DebugFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly source?: { readonly path?: string; readonly name?: string };
}

export interface DebugSourceLine {
  readonly lineNumber: number;
  readonly content: string;
  readonly current: boolean;
}

export interface DebugStop {
  readonly generation: number;
  readonly reason: string;
  readonly threadId: number;
  readonly frame?: DebugFrame;
  readonly variables: readonly DebugVariable[];
  readonly sourceLines: readonly DebugSourceLine[];
}

export interface DebugSession {
  readonly id: string;
  readonly source: string;
  readonly options: DebugSessionOptions;
  readonly breakpoints: Map<string, DebugBreakpoint>;
  status: DebugSessionStatus;
  client?: DapClient;
  controlClient?: DapClient;
  clients?: DapClient[];
  adapterProcess?: ChildProcess;
  adapterTemporaryDirectory?: string;
  targetReady?: Promise<void>;
  resolveTargetReady?: () => void;
  rPromptInputs?: string[];
  rAtBrowserPrompt?: boolean;
  rStarted?: boolean;
  stop?: DebugStop;
  stopGeneration: number;
}

export interface DebugSessionSnapshot {
  readonly id: string;
  readonly source: string;
  readonly options: DebugSessionOptions;
  readonly status: DebugSessionStatus;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly stop?: DebugStop;
}

type DebugSessionChangeListener = (snapshot: DebugSessionSnapshot) => void;

interface ThreadsBody {
  readonly threads?: readonly { readonly id: number; readonly name: string }[];
}
interface StackTraceBody {
  readonly stackFrames?: readonly DebugFrame[];
}
interface ScopesBody {
  readonly scopes?: readonly {
    readonly name: string;
    readonly presentationHint?: string;
    readonly variablesReference: number;
  }[];
}
interface VariablesBody {
  readonly variables?: readonly DebugVariable[];
}
interface SetBreakpointsBody {
  readonly breakpoints?: readonly { readonly verified?: boolean; readonly line?: number }[];
}

/** Owns debug sessions and keeps DAP references scoped to their current stop. */
export class DebugSessionManager {
  readonly #sessions = new Map<string, DebugSession>();
  readonly #changeListeners = new Set<DebugSessionChangeListener>();

  /** Create a configured session without launching the debuggee. */
  create(
    options: Omit<DebugSessionOptions, "sourceFile"> & { readonly sourceFile?: string },
  ): DebugSession {
    const id = randomBytes(6).toString("hex");
    const session: DebugSession = {
      id,
      source: `debug:${id}`,
      options: { ...options, sourceFile: options.sourceFile ?? options.program },
      breakpoints: new Map(),
      status: "configured",
      stopGeneration: 0,
    };
    this.#sessions.set(id, session);
    this.#notify(session);
    return session;
  }

  /** Resolve a session URI or one of its child resources. */
  get(source: string): DebugSession | undefined {
    const match = /^debug:([a-f\d]{12})(?:\/|$)/u.exec(source);
    return match === null ? undefined : this.#sessions.get(match[1] as string);
  }

  /** List sessions owned by the current Pi process. */
  list(): readonly DebugSession[] {
    return [...this.#sessions.values()];
  }

  /** Return immutable presentation data without exposing the adapter client. */
  snapshot(session: DebugSession): DebugSessionSnapshot {
    return {
      id: session.id,
      source: session.source,
      options: session.options,
      status: session.status,
      breakpoints: [...session.breakpoints.values()].map((breakpoint) => ({ ...breakpoint })),
      ...(session.stop === undefined ? {} : { stop: session.stop }),
    };
  }

  /** Observe session state changes used by debugger activity UI. */
  onDidChange(listener: DebugSessionChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Find breakpoints for a file, optionally scoped to one debug session. */
  breakpointsForFile(file: string, sessionSource?: string): readonly DebugBreakpoint[] {
    const absolute = path.resolve(file);
    return this.list()
      .filter((session) => sessionSource === undefined || session.source === sessionSource)
      .flatMap((session) => [...session.breakpoints.values()])
      .filter((breakpoint) => path.resolve(breakpoint.file) === absolute);
  }

  /** Return the source file represented by a session-owned source URI. */
  sourceFile(source: string): string | undefined {
    const session = this.get(source);
    return session !== undefined && source === `${session.source}/source`
      ? session.options.sourceFile
      : undefined;
  }

  /** Create the stable session-owned URI for source text. */
  sourceResource(session: DebugSession): string {
    return `${session.source}/source`;
  }

  /** Read fresh source text so normal anchors detect edits before breakpoint creation. */
  readSource(source: string): Promise<string> {
    const file = this.sourceFile(source);
    if (file === undefined) return Promise.reject(new Error(`Unknown debug source ${source}`));
    return readFile(file, "utf8");
  }

  /** Store one breakpoint selected against a fresh source snapshot. */
  async addBreakpoint(
    source: string,
    line: number,
    signal?: AbortSignal,
  ): Promise<DebugBreakpoint> {
    const session = this.get(source);
    const file = this.sourceFile(source);
    if (session === undefined || file === undefined)
      throw new Error(`Unknown debug source ${source}`);
    if (session.status === "terminated")
      throw new Error("Cannot add a breakpoint to a terminated session");
    const id = randomBytes(5).toString("hex");
    const breakpoint: DebugBreakpoint = {
      id,
      source: `${session.source}/breakpoint/${id}`,
      file,
      line,
      verified: false,
    };
    session.breakpoints.set(id, breakpoint);
    if (session.client !== undefined)
      await this.#configureBreakpointFile(session, session.client, file, signal);
    this.#notify(session);
    return breakpoint;
  }

  /** Resolve one stored breakpoint URI. */
  breakpoint(source: string): DebugBreakpoint | undefined {
    const session = this.get(source);
    return session === undefined
      ? undefined
      : [...session.breakpoints.values()].find((breakpoint) => breakpoint.source === source);
  }

  /** Launch the debuggee, configure breakpoints, and wait for a stop or termination. */
  async start(session: DebugSession, signal?: AbortSignal): Promise<DebugSession> {
    return this.#start(session, signal, 2);
  }

  async #start(
    session: DebugSession,
    signal: AbortSignal | undefined,
    retriesLeft: number,
  ): Promise<DebugSession> {
    if (session.status !== "configured") throw new Error(`Session is already ${session.status}`);
    if (session.options.adapter === "powershell") {
      session.adapterTemporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "pi-powershell-debug-"),
      );
    }
    const recipe = adapterRecipe(session.options, session.adapterTemporaryDirectory);
    const client =
      session.options.adapter === "node"
        ? await this.#startNodeAdapter(session)
        : session.options.adapter === "delve"
          ? await this.#startDelveAdapter(session)
          : session.options.adapter === "ruby"
            ? await this.#startRubyAdapter(session)
            : session.options.adapter === "julia"
              ? await this.#startJuliaAdapter(session)
              : session.options.adapter === "r"
                ? await this.#startRAdapter(session)
                : DapClient.start(recipe.command, recipe.args, session.options.cwd);
    session.client = client;
    session.controlClient = client;
    session.clients = [client];
    if (session.options.adapter === "node") {
      session.targetReady = new Promise((resolve) => {
        session.resolveTargetReady = resolve;
      });
    }
    session.status = "running";
    this.#notify(session);
    try {
      if (session.options.adapter !== "r") {
        await initializeClient(client, recipe.adapterID, signal);
      }
      const initialized = client.waitForAnyEvent(["initialized"], 30_000, signal);
      const launch = client.request(recipe.request, recipe.launch, { signal });
      await initialized;
      await this.#configureBreakpoints(session, client, signal);
      const configurationDone = client.request("configurationDone", undefined, { signal });
      if (session.options.adapter === "java" || session.options.adapter === "kotlin") {
        // kotlin-debug-adapter deliberately keeps this response pending for the session lifetime.
        void configurationDone.catch(() => {});
      } else {
        await configurationDone;
      }
      await launch;
      if (session.options.adapter === "r") session.rStarted = true;
      if (session.targetReady !== undefined) await session.targetReady;
      await this.#waitForStop(session, signal);
      if (
        this.snapshot(session).status === "terminated" &&
        retriesLeft > 0 &&
        (session.options.adapter === "dart" || session.options.adapter === "kotlin") &&
        session.breakpoints.size > 0
      ) {
        // These adapters can start the debuggee before source breakpoints bind under load.
        // Relaunching creates a fresh suspended VM and gives breakpoint binding another chance.
        for (const activeClient of session.clients ?? [client]) activeClient.close();
        session.adapterProcess?.kill();
        await removeAdapterTemporaryDirectory(session);
        session.client = undefined;
        session.controlClient = undefined;
        session.clients = undefined;
        session.adapterProcess = undefined;
        session.status = "configured";
        for (const breakpoint of session.breakpoints.values()) breakpoint.verified = false;
        this.#notify(session);
        return await this.#start(session, signal, retriesLeft - 1);
      }
      return session;
    } catch (error) {
      for (const activeClient of session.clients ?? [client]) activeClient.close();
      session.adapterProcess?.kill();
      await removeAdapterTemporaryDirectory(session);
      session.client = undefined;
      session.controlClient = undefined;
      session.clients = undefined;
      session.adapterProcess = undefined;
      session.targetReady = undefined;
      session.resolveTargetReady = undefined;
      session.status = "configured";
      this.#notify(session);
      throw error;
    }
  }

  /** Continue or step and wait for the next observable execution state. */
  async command(
    session: DebugSession,
    command: "continue" | "next" | "stepIn" | "stepOut",
    signal?: AbortSignal,
  ): Promise<DebugSession> {
    if (session.status !== "stopped" || session.stop === undefined) {
      throw new Error(`Cannot ${command} while session is ${session.status}`);
    }
    const client = requiredClient(session);
    const threadId = session.stop.threadId;
    await client.request(command, { threadId }, { signal });
    session.stop = undefined;
    session.status = "running";
    this.#notify(session);
    await this.#waitForStop(session, signal);
    return session;
  }

  /** Terminate an owned debuggee and remove its session. */
  async delete(source: string, signal?: AbortSignal): Promise<void> {
    const session = this.get(source);
    if (session === undefined) throw new Error(`Unknown debug session ${source}`);
    const breakpointMatch = /\/breakpoint\/([a-f\d]{10})$/u.exec(source);
    if (breakpointMatch !== null) {
      const breakpoint = session.breakpoints.get(breakpointMatch[1] as string);
      if (breakpoint === undefined) throw new Error(`Unknown debug breakpoint ${source}`);
      session.breakpoints.delete(breakpoint.id);
      if (session.client !== undefined && session.status !== "terminated") {
        await this.#configureBreakpointFile(session, session.client, breakpoint.file, signal);
      }
      this.#notify(session);
      return;
    }
    if (source !== session.source) throw new Error(`Cannot delete debug resource ${source}`);
    if (session.client !== undefined) {
      void (session.controlClient ?? session.client)
        .request("disconnect", { terminateDebuggee: true }, { signal, timeoutMs: 500 })
        .catch(() => {});
      for (const client of session.clients ?? [session.client]) client.close();
      session.adapterProcess?.kill();
    }
    await removeAdapterTemporaryDirectory(session);
    session.status = "terminated";
    this.#notify(session);
    this.#sessions.delete(session.id);
  }

  /** Stop all owned adapter processes during Pi shutdown. */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      for (const client of session.clients ??
        (session.client === undefined ? [] : [session.client])) {
        client.close();
      }
      session.adapterProcess?.kill();
      if (session.adapterTemporaryDirectory !== undefined) {
        rmSync(session.adapterTemporaryDirectory, { recursive: true, force: true });
      }
    }
    this.#sessions.clear();
  }

  async #startRubyAdapter(session: DebugSession): Promise<DapClient> {
    const port = await availablePort();
    const command = process.env.PI_RUBY_DEBUG_PATH ?? "rdbg";
    session.adapterProcess = spawn(
      command,
      [
        "--open",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-rc",
        "--",
        session.options.program,
        ...session.options.args,
      ],
      {
        cwd: session.options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitForAdapterReady(session.adapterProcess, "Debugger can attach via TCP/IP", "rdbg");
    return DapClient.connect(port);
  }

  async #startDelveAdapter(session: DebugSession): Promise<DapClient> {
    const port = await availablePort();
    const command = process.env.PI_DELVE_PATH ?? "dlv";
    session.adapterProcess = spawn(
      command,
      ["dap", `--listen=127.0.0.1:${String(port)}`, "--log=false"],
      {
        cwd: session.options.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    session.adapterProcess.stderr?.on("data", () => {
      // Delve status output is not DAP transport.
    });
    await waitForAdapterReady(session.adapterProcess, "DAP server listening", "Delve");
    return DapClient.connect(port);
  }
  async #startJuliaAdapter(session: DebugSession): Promise<DapClient> {
    const port = await availablePort();
    const command = process.env.PI_JULIA_PATH ?? "julia";
    const project = process.env.PI_JULIA_DEBUG_PROJECT ?? "/opt/pi-debug-adapters/julia";
    const script =
      'using Sockets, DebugAdapter; server = listen(ip"127.0.0.1", parse(Int, ARGS[1])); conn = accept(server); run(DebugAdapter.DebugSession(conn)); close(server)';
    session.adapterProcess = spawn(
      command,
      [
        "--startup-file=no",
        "--history-file=no",
        `--project=${project}`,
        "-e",
        script,
        String(port),
      ],
      { cwd: session.options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    traceAdapterProcess(session.adapterProcess, `DebugAdapter.jl:${String(port)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return connectWithRetry(port, "DebugAdapter.jl");
  }

  async #startRAdapter(session: DebugSession): Promise<DapClient> {
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    if (address === null || typeof address === "string") {
      listener.close();
      throw new Error("Could not start the vscDebugger DAP listener");
    }
    const clientPromise = new Promise<DapClient>((resolve, reject) => {
      listener.once("connection", (socket) => {
        listener.close();
        const client = DapClient.fromSocket(socket, 2);
        client.onEvent((event) => this.#handleRAdapterEvent(session, event));
        resolve(client);
      });
      listener.once("error", reject);
    });
    const command = process.env.PI_R_PATH ?? "R";
    session.rPromptInputs = [];
    session.rAtBrowserPrompt = false;
    session.rStarted = false;
    session.adapterProcess = spawn(command, ["--vanilla", "--quiet"], {
      cwd: session.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    traceAdapterProcess(session.adapterProcess, `vscDebugger:${String(address.port)}`);
    this.#watchRPrompts(session);
    const initialize = dapFrame({
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: {
        clientID: "pi-agent-ide",
        adapterID: "R-Debugger",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsVariablePaging: true,
        supportsWriteToStdinEvent: true,
        supportsStdoutReading: true,
        rStrings: {
          packageName: "vscDebugger",
          prompt: "__PI_R_PROMPT__",
          continue: "__PI_R_CONTINUE__",
          attachName: "tools:vscDebugger",
        },
        useDapSocket: true,
        dapHost: "127.0.0.1",
        dapPort: address.port,
      },
    });
    session.adapterProcess.stdin?.write(
      `library(vscDebugger); vscDebugger:::.vsc.handleDap(${JSON.stringify(initialize)})\n`,
    );
    return waitForRAdapterConnection(clientPromise, session.adapterProcess, listener);
  }

  #handleRAdapterEvent(session: DebugSession, event: DapEvent): void {
    if (process.env.PI_DEBUG_DAP_TRACE === "1") {
      process.stderr.write(`[vscDebugger:event] ${JSON.stringify(event)}\n`);
    }
    if (event.event !== "custom") return;
    const body = asRecord(event.body);
    const reason = typeof body.reason === "string" ? body.reason : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (reason !== "writeToStdin" || text.length === 0) return;
    if (body.when === "browserPrompt" && session.rAtBrowserPrompt === true) {
      session.rAtBrowserPrompt = false;
      session.adapterProcess?.stdin?.write(`${text}\n`);
      return;
    }
    session.rPromptInputs?.push(text);
  }

  #watchRPrompts(session: DebugSession): void {
    let output = "";
    session.adapterProcess?.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (;;) {
        const browser = /Browse\[\d+\]> /u.exec(output);
        const topLevel = /(?:^|\r?\n)__PI_R_PROMPT__(?:\r?\n|$)/u.exec(output);
        const browserIndex = browser?.index ?? Number.POSITIVE_INFINITY;
        const topLevelIndex = topLevel?.index ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(browserIndex) && !Number.isFinite(topLevelIndex)) {
          output = output.slice(-128);
          return;
        }
        if (browserIndex < topLevelIndex) {
          output = output.slice(browserIndex + (browser?.[0].length ?? 0));
          const input = session.rPromptInputs?.shift();
          if (input === undefined) {
            session.rAtBrowserPrompt = true;
            // Prompt output can arrive just before its flow-control event on the DAP socket.
            setTimeout(() => {
              if (session.rAtBrowserPrompt !== true) return;
              session.rAtBrowserPrompt = false;
              session.adapterProcess?.stdin?.write("vscDebugger::.vsc.listenForDAP(timeout=-1)\n");
            }, 100);
          } else {
            session.adapterProcess?.stdin?.write(`${input}\n`);
          }
        } else {
          output = output.slice(topLevelIndex + (topLevel?.[0].length ?? 0));
          session.adapterProcess?.stdin?.write("vscDebugger::.vsc.listenForDAP(timeout=-1)\n");
          if (session.rStarted === true) {
            void session.client
              ?.request("custom", { reason: "showingPrompt", which: "topLevel" })
              .catch(() => {});
          }
        }
      }
    });
  }

  async #startNodeAdapter(session: DebugSession): Promise<DapClient> {
    const port = await availablePort();
    const server =
      process.env.PI_JS_DEBUG_PATH ?? "/opt/pi-debug-adapters/js-debug/src/dapDebugServer.js";
    session.adapterProcess = spawn(process.execPath, [server, String(port), "127.0.0.1"], {
      cwd: session.options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.adapterProcess.stderr?.on("data", () => {
      // Server stderr is diagnostic output, not DAP transport.
    });
    await waitForJsDebugReady(session.adapterProcess);
    const client = await connectWithRetry(port);
    client.onReverseRequest(this.#handleNodeReverseRequest(session, port));
    return client;
  }

  #handleNodeReverseRequest(
    session: DebugSession,
    port: number,
  ): (request: DapReverseRequest) => Promise<unknown> {
    return async (request) => {
      if (request.command !== "startDebugging") {
        throw new Error(`Client does not support reverse request ${request.command}`);
      }
      const arguments_ = asRecord(request.arguments);
      const configuration = asRecord(arguments_.configuration);
      const child = await DapClient.connect(port);
      session.clients?.push(child);
      child.onReverseRequest(this.#handleNodeReverseRequest(session, port));
      await initializeClient(child, "pwa-node");
      const initialized = child.waitForEvent("initialized");
      const launch = child.request(
        typeof arguments_.request === "string" ? arguments_.request : "launch",
        {
          ...configuration,
          sourceMaps: true,
          pauseForSourceMap: true,
          outFiles: [path.join(path.dirname(session.options.program), "**", "*.js")],
        },
      );
      await initialized;
      session.client = child;
      await this.#configureBreakpoints(session, child);
      await child.request("configurationDone");
      await launch;
      session.resolveTargetReady?.();
      return {};
    };
  }

  async #configureBreakpoints(
    session: DebugSession,
    client: DapClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const files = new Set([...session.breakpoints.values()].map((breakpoint) => breakpoint.file));
    for (const file of files) await this.#configureBreakpointFile(session, client, file, signal);
  }

  async #configureBreakpointFile(
    session: DebugSession,
    client: DapClient,
    file: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const breakpoints = [...session.breakpoints.values()].filter(
      (breakpoint) => breakpoint.file === file,
    );
    const response = await client.request<SetBreakpointsBody>(
      "setBreakpoints",
      {
        source: { path: file, name: path.basename(file) },
        breakpoints: breakpoints.map(({ line }) => ({ line })),
        sourceModified: false,
      },
      { signal },
    );
    for (const [index, breakpoint] of breakpoints.entries()) {
      breakpoint.verified = response.breakpoints?.[index]?.verified === true;
    }
  }

  async #waitForStop(session: DebugSession, signal?: AbortSignal): Promise<void> {
    const event = await requiredClient(session).waitForAnyEvent(
      ["stopped", "terminated", "exited", "loadedSource", "breakpoint", "custom"],
      30_000,
      signal,
    );
    const body = asRecord(event.body);
    if (event.event === "custom" && session.options.adapter === "r") {
      await this.#waitForStop(session, signal);
      return;
    }
    if (event.event === "loadedSource") {
      const source = asRecord(body.source);
      const loadedPath = typeof source.path === "string" ? path.resolve(source.path) : undefined;
      const breakpointFile =
        loadedPath === undefined
          ? undefined
          : [...session.breakpoints.values()].find(
              (breakpoint) => path.resolve(breakpoint.file) === loadedPath,
            )?.file;
      if (breakpointFile !== undefined)
        await this.#configureBreakpointFile(
          session,
          requiredClient(session),
          breakpointFile,
          signal,
        );
      await this.#waitForStop(session, signal);
      return;
    }
    if (event.event === "breakpoint") {
      const changed = asRecord(body.breakpoint);
      const changedSource = asRecord(changed.source);
      for (const breakpoint of session.breakpoints.values()) {
        if (
          changed.verified === true &&
          typeof changed.line === "number" &&
          changed.line === breakpoint.line &&
          typeof changedSource.path === "string" &&
          path.resolve(changedSource.path) === path.resolve(breakpoint.file)
        ) {
          breakpoint.verified = true;
        }
      }
      await this.#waitForStop(session, signal);
      return;
    }
    if (body.reason === "exit") {
      session.status = "terminated";
      session.stop = undefined;
      this.#notify(session);
      return;
    }
    if (session.options.adapter === "node" && body.reason === "entry") {
      await this.#configureBreakpoints(session, requiredClient(session), signal);
      const threadId = typeof body.threadId === "number" ? body.threadId : 1;
      await requiredClient(session).request("continue", { threadId }, { signal });
      await this.#waitForStop(session, signal);
      return;
    }
    if (
      (session.options.adapter === "dart" || session.options.adapter === "kotlin") &&
      body.reason === "entry"
    ) {
      const client = requiredClient(session);
      await this.#configureBreakpoints(session, client, signal);
      if (session.options.adapter === "kotlin") {
        // The Kotlin adapter can acknowledge an unbound source breakpoint while the VM is
        // stopped on entry. Keep the VM suspended until the class has loaded and the adapter
        // confirms the breakpoint; continuing earlier races the entire short-lived program.
        const deadline = Date.now() + 5_000;
        while (
          [...session.breakpoints.values()].some((breakpoint) => !breakpoint.verified) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await this.#configureBreakpoints(session, client, signal);
        }
      }
      const threadId = typeof body.threadId === "number" ? body.threadId : 1;
      await client.request("continue", { threadId }, { signal });
      await this.#waitForStop(session, signal);
      return;
    }
    if (event.event !== "stopped") {
      session.status = "terminated";
      session.stop = undefined;
      this.#notify(session);
      return;
    }
    await this.#captureStop(session, event, session.options.adapter !== "shell");
    if (session.options.adapter === "r" && session.stop?.frame?.source?.path === undefined) {
      session.stopGeneration--;
      session.stop = undefined;
      session.status = "running";
      await this.#waitForStop(session, signal);
      return;
    }
    if (
      session.options.adapter === "shell" &&
      session.stop?.frame !== undefined &&
      ![...session.breakpoints.values()].some(
        (breakpoint) =>
          path.resolve(breakpoint.file) === path.resolve(session.stop?.frame?.source?.path ?? "") &&
          breakpoint.line === session.stop?.frame?.line,
      )
    ) {
      const threadId = session.stop.threadId;
      session.stopGeneration--;
      session.stop = undefined;
      session.status = "running";
      await requiredClient(session).request("continue", { threadId }, { signal });
      await this.#waitForStop(session, signal);
      return;
    }
    if (session.options.adapter === "shell") this.#notify(session);
  }

  async #captureStop(session: DebugSession, event: DapEvent, notify = true): Promise<void> {
    const client = requiredClient(session);
    const body = asRecord(event.body);
    const fallbackThread = (await client.request<ThreadsBody>("threads")).threads?.[0]?.id;
    const threadId = typeof body.threadId === "number" ? body.threadId : fallbackThread;
    if (threadId === undefined) throw new Error("Debugger stopped without a thread");
    const frame = (await requestStackTrace(client, threadId, session.options.adapter === "dart"))
      .stackFrames?.[0];
    if (frame?.source?.path !== undefined) {
      for (const breakpoint of session.breakpoints.values()) {
        if (
          path.resolve(breakpoint.file) === path.resolve(frame.source.path) &&
          breakpoint.line === frame.line
        ) {
          breakpoint.verified = true;
        }
      }
    }
    const variables: DebugVariable[] = [];
    if (frame !== undefined) {
      const scopes =
        (await client.request<ScopesBody>("scopes", { frameId: frame.id })).scopes ?? [];
      const localScopes =
        session.options.adapter === "r"
          ? scopes
          : scopes.filter((item) =>
              [item.name.toLowerCase(), item.presentationHint?.toLowerCase()].some(
                (value) => value?.includes("local") === true || value === "variables",
              ),
            );
      for (const scope of localScopes) {
        const values = await client.request<VariablesBody>("variables", {
          variablesReference: scope.variablesReference,
          start: 0,
          count: 100,
        });
        variables.push(...(values.variables ?? []));
      }
    }
    session.stopGeneration++;
    session.stop = {
      generation: session.stopGeneration,
      reason: typeof body.reason === "string" ? body.reason : "stopped",
      threadId,
      ...(frame === undefined ? {} : { frame }),
      variables,
      sourceLines: frame === undefined ? [] : await sourceWindow(frame),
    };
    session.status = "stopped";
    if (notify) this.#notify(session);
  }

  #notify(session: DebugSession): void {
    const snapshot = this.snapshot(session);
    for (const listener of this.#changeListeners) listener(snapshot);
  }
}

async function sourceWindow(frame: DebugFrame): Promise<readonly DebugSourceLine[]> {
  const file = frame.source?.path;
  if (file === undefined) return [];
  try {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    const start = Math.max(1, frame.line - 2);
    const end = Math.min(lines.length, frame.line + 2);
    return lines.slice(start - 1, end).map((content, index) => ({
      lineNumber: start + index,
      content,
      current: start + index === frame.line,
    }));
  } catch {
    return [];
  }
}

async function requestStackTrace(
  client: DapClient,
  threadId: number,
  retryCollected: boolean,
): Promise<StackTraceBody> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  do {
    try {
      const response = await client.request<StackTraceBody>("stackTrace", { threadId });
      if (!retryCollected || (response.stackFrames?.length ?? 0) > 0) return response;
      lastError = new Error("Debugger stack is not ready");
    } catch (error) {
      lastError = error;
      if (!retryCollected) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error("Could not read debugger stack");
}
/** Render the compact state returned by read and semantic commands. */
export function renderDebugSession(session: DebugSession): string {
  const lines = [
    `Session: ${session.source}`,
    `Adapter: ${session.options.adapter}`,
    `Program: ${path.relative(session.options.cwd, session.options.program) || session.options.program}`,
    `Status: ${session.status}`,
  ];
  if (session.breakpoints.size > 0) {
    lines.push("", "Breakpoints:");
    for (const breakpoint of session.breakpoints.values()) {
      lines.push(
        `- ${breakpoint.source} ${path.relative(session.options.cwd, breakpoint.file)}:${breakpoint.line} (${breakpoint.verified ? "verified" : "pending"})`,
      );
    }
  }
  if (session.stop !== undefined) {
    const { stop } = session;
    lines.push("", `Stop: ${stop.generation} (${stop.reason})`, `Thread: ${stop.threadId}`);
    if (stop.frame !== undefined) {
      lines.push(
        `Frame: ${stop.frame.name} at ${stop.frame.source?.path ?? stop.frame.source?.name ?? "unknown"}:${stop.frame.line}`,
      );
    }
    if (stop.variables.length > 0) {
      lines.push("", "Locals:");
      for (const variable of stop.variables) {
        lines.push(
          `- ${variable.name}: ${variable.value}${variable.type === undefined ? "" : ` (${variable.type})`}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function requiredClient(session: DebugSession): DapClient {
  if (session.client === undefined) throw new Error("Debug adapter is not running");
  return session.client;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function dapFrame(message: unknown): string {
  const payload = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

function initializeClient(
  client: DapClient,
  adapterID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request(
    "initialize",
    {
      clientID: "pi-agent-ide",
      adapterID,
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    },
    { signal },
  );
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a debug adapter port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

function traceAdapterProcess(child: ChildProcess, adapter: string): void {
  if (process.env.PI_DEBUG_DAP_TRACE !== "1") return;
  process.stderr.write(`[${adapter}] pid=${String(child.pid)}\n`);
  child.once("exit", (code, signal) =>
    process.stderr.write(`[${adapter}] exit code=${String(code)} signal=${String(signal)}\n`),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) =>
      process.stderr.write(`[${adapter}] ${chunk.toString("utf8")}`),
    );
  }
}

function waitForRAdapterConnection(
  connection: Promise<DapClient>,
  child: ChildProcess,
  listener: net.Server,
): Promise<DapClient> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("Timed out starting vscDebugger")), 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("error", fail);
      child.off("exit", onExit);
    };
    const fail = (error: Error): void => {
      cleanup();
      listener.close();
      if (!child.killed) child.kill();
      reject(error);
    };
    const onExit = (code: number | null): void =>
      fail(new Error(`vscDebugger exited with code ${String(code)} before connecting`));
    child.once("error", fail);
    child.once("exit", onExit);
    void connection.then((client) => {
      cleanup();
      resolve(client);
    }, fail);
  });
}

function waitForAdapterReady(child: ChildProcess, marker: string, adapter: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const streams = [child.stdout, child.stderr].filter((stream) => stream !== null);
    const timer = setTimeout(
      () => reject(new Error(`Timed out starting ${adapter} server`)),
      5_000,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const stream of streams) stream.off("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString("utf8").includes(marker)) return;
      cleanup();
      resolve();
    };
    for (const stream of streams) stream.on("data", onData);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      reject(new Error(`${adapter} server exited with code ${String(code)}`));
    });
  });
}
function waitForJsDebugReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error("js-debug server stdout is unavailable"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timed out starting js-debug server")), 5_000);
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString("utf8").includes("Debug server listening")) return;
      clearTimeout(timer);
      stdout.off("data", onData);
      resolve();
    };
    stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`js-debug server exited with code ${code}`)));
  });
}
async function connectWithRetry(port: number, adapter = "js-debug"): Promise<DapClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await DapClient.connect(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not connect to ${adapter}`);
}

async function removeAdapterTemporaryDirectory(session: DebugSession): Promise<void> {
  if (session.adapterTemporaryDirectory === undefined) return;
  await rm(session.adapterTemporaryDirectory, { recursive: true, force: true });
  session.adapterTemporaryDirectory = undefined;
}

interface AdapterRecipe {
  readonly command: string;
  readonly args: readonly string[];
  readonly adapterID: string;
  readonly request: "attach" | "launch";
  readonly launch: Readonly<Record<string, unknown>>;
}

function adapterRecipe(
  options: DebugSessionOptions,
  adapterTemporaryDirectory?: string,
): AdapterRecipe {
  const common = {
    name: "Pi Agent IDE debug session",
    request: "launch",
    program: options.program,
    cwd: options.cwd,
    args: [...options.args],
  };
  if (options.adapter === "dart") {
    return {
      command: process.env.PI_DART_PATH ?? "dart",
      args: ["debug_adapter"],
      adapterID: "dart",
      request: "launch",
      launch: {
        ...common,
        type: "dart",
        debugSdkLibraries: false,
        debugExternalPackageLibraries: false,
        stopOnEntry: true,
        vmAdditionalArgs: ["--pause-isolates-on-start"],
      },
    };
  }
  if (options.adapter === "debugpy") {
    return {
      command: "python3",
      args: ["-m", "debugpy.adapter"],
      adapterID: "debugpy",
      request: "launch",
      launch: { ...common, type: "python", console: "internalConsole", justMyCode: false },
    };
  }
  if (options.adapter === "java" || options.adapter === "kotlin") {
    if (options.mainClass === undefined) {
      throw new Error("Java and Kotlin debug sessions require mainClass");
    }
    return {
      command: process.env.PI_KOTLIN_DEBUG_ADAPTER_PATH ?? "kotlin-debug-adapter",
      args: [],
      adapterID: options.adapter,
      request: "launch",
      launch: {
        ...common,
        type: "kotlin",
        mainClass: options.mainClass,
        projectRoot: options.cwd,
        stopOnEntry: true,
      },
    };
  }
  if (options.adapter === "netcoredbg") {
    return {
      command: process.env.PI_NETCOREDBG_PATH ?? "netcoredbg",
      args: ["--interpreter=vscode"],
      adapterID: "coreclr",
      request: "launch",
      launch: { ...common, type: "coreclr", console: "internalConsole" },
    };
  }
  if (options.adapter === "elixir") {
    return {
      command:
        process.env.PI_ELIXIR_LS_DEBUG_PATH ?? "/opt/pi-debug-adapters/elixir-ls/debug_adapter.sh",
      args: [],
      adapterID: "mix_task",
      request: "launch",
      launch: {
        name: common.name,
        request: "launch",
        type: "mix_task",
        task: "run",
        taskArgs: [options.program, ...options.args],
        projectDir: options.cwd,
        startApps: true,
        exitAfterTaskReturns: true,
      },
    };
  }
  if (options.adapter === "julia") {
    return {
      command: process.env.PI_JULIA_PATH ?? "julia",
      args: [],
      adapterID: "julia",
      request: "launch",
      launch: { ...common, type: "julia", stopOnEntry: false },
    };
  }
  if (options.adapter === "lldb-dap") {
    return {
      command: process.env.PI_LLDB_DAP_PATH ?? "lldb-dap-18",
      args: [],
      adapterID: "lldb-dap",
      request: "launch",
      launch: { ...common, type: "lldb-dap" },
    };
  }
  if (options.adapter === "delve") {
    return {
      command: process.env.PI_DELVE_PATH ?? "dlv",
      args: [],
      adapterID: "go",
      request: "launch",
      launch: { ...common, type: "go", mode: "debug" },
    };
  }
  if (options.adapter === "r") {
    return {
      command: process.env.PI_R_PATH ?? "R",
      args: [],
      adapterID: "R-Debugger",
      request: "launch",
      launch: {
        name: common.name,
        request: "launch",
        type: "R-Debugger",
        debugMode: "file",
        file: options.program,
        workingDirectory: options.cwd,
        commandLineArgs: [...options.args],
        allowGlobalDebugging: false,
        loadPackages: [],
        supportsStdoutReading: true,
        supportsWriteToStdinEvent: true,
        overwriteHelp: false,
      },
    };
  }
  if (options.adapter === "ruby") {
    return {
      command: process.env.PI_RUBY_DEBUG_PATH ?? "rdbg",
      args: [],
      adapterID: "rdbg",
      request: "launch",
      launch: { ...common, type: "rdbg" },
    };
  }
  if (options.adapter === "php") {
    return {
      command: process.execPath,
      args: [
        process.env.PI_PHP_DEBUG_PATH ??
          "/opt/pi-debug-adapters/php-debug/extension/out/phpDebug.js",
      ],
      adapterID: "php",
      request: "launch",
      launch: {
        ...common,
        type: "php",
        runtimeExecutable: process.env.PI_PHP_PATH ?? "php",
        runtimeArgs: ["-dxdebug.start_with_request=yes"],
        console: "internalConsole",
        port: 0,
        env: { XDEBUG_MODE: "debug,develop", XDEBUG_CONFIG: "client_port=${port}" },
      },
    };
  }
  if (options.adapter === "lua") {
    return {
      command: process.execPath,
      args: [
        process.env.PI_LUA_DEBUG_PATH ??
          "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
      ],
      adapterID: "lua-local",
      request: "launch",
      launch: {
        ...common,
        type: "lua-local",
        program: { lua: process.env.PI_LUA_PATH ?? "lua", file: options.program },
        extensionPath: path.dirname(
          path.dirname(
            process.env.PI_LUA_DEBUG_PATH ??
              "/opt/pi-debug-adapters/lua-debug/extension/extension/debugAdapter.js",
          ),
        ),
        workspacePath: options.cwd,
      },
    };
  }
  if (options.adapter === "shell") {
    const extension =
      process.env.PI_BASH_DEBUG_ROOT ?? "/opt/pi-debug-adapters/bash-debug/extension";
    return {
      command: process.execPath,
      args: [process.env.PI_BASH_DEBUG_PATH ?? path.join(extension, "out/bashDebug.js")],
      adapterID: "bashdb",
      request: "launch",
      launch: {
        ...common,
        type: "bashdb",
        pathBash: process.env.PI_BASH_PATH ?? "/usr/bin/bash",
        pathBashdb: path.join(extension, "bashdb_dir/bashdb"),
        pathBashdbLib: path.join(extension, "bashdb_dir"),
        pathCat: "/usr/bin/cat",
        pathMkfifo: "/usr/bin/mkfifo",
        pathPkill: "/usr/bin/pkill",
        terminalKind: "debugConsole",
        argsString: "",
        env: {},
        showDebugOutput: false,
        trace: false,
      },
    };
  }
  if (options.adapter === "powershell") {
    const bundle =
      process.env.PI_POWERSHELL_EDITOR_SERVICES_PATH ??
      "/opt/pi-debug-adapters/powershell-editor-services";
    if (adapterTemporaryDirectory === undefined) {
      throw new Error("PowerShell debugger temporary directory was not created");
    }
    return {
      command: process.env.PI_PWSH_PATH ?? "pwsh",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `& '${path.join(bundle, "PowerShellEditorServices/Start-EditorServices.ps1").replaceAll("'", "''")}' -LogPath '${path.join(adapterTemporaryDirectory, "logs").replaceAll("'", "''")}' -LogLevel Warning -SessionDetailsPath '${path.join(adapterTemporaryDirectory, "session.json").replaceAll("'", "''")}' -FeatureFlags @() -AdditionalModules @() -HostName 'Pi Agent IDE' -HostProfileId 'pi-agent-ide' -HostVersion '1.0.0' -BundledModulesPath '${bundle.replaceAll("'", "''")}' -Stdio -DebugServiceOnly`,
      ],
      adapterID: "PowerShell",
      request: "launch",
      launch: {
        ...common,
        script: options.program,
        createTemporaryIntegratedConsole: false,
        executeMode: "Call",
      },
    };
  }
  return {
    command: process.execPath,
    args: [],
    adapterID: "pwa-node",
    request: "launch",
    launch: {
      ...common,
      type: "pwa-node",
      console: "internalConsole",
      autoAttachChildProcesses: false,
      stopOnEntry: true,
      sourceMaps: true,
      pauseForSourceMap: true,
      outFiles: [path.join(path.dirname(options.program), "**", "*.js")],
    },
  };
}
