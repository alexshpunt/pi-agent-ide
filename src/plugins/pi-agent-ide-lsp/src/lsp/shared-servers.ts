import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { SHARED_SERVER_PROTOCOL } from "./server-request-handlers.mjs";

/**
 * Pi sessions on one machine share language servers through host processes.
 *
 * A host (shared-server-host.mjs) runs one language server for one configuration: server ID,
 * command, configured environment, workspace root, initialization options and settings. Its
 * socket name is a hash of that configuration in a directory only this user can access. The
 * first session that finds no host starts one detached, so the server outlives that session.
 *
 * A session connects, sends one JSON line with the configuration and its initialize parameters,
 * and receives one JSON line with the server PID once the server is initialized. After that the
 * socket carries ordinary LSP messages. The host initializes the server once, answers server
 * requests itself, keeps one server copy of each document open while any session has it open,
 * gives the server the requesting session's text before each request, and reports document
 * versions in each session's own numbering. It stops the server after its last session has been
 * gone for the linger time.
 */

/** Stop a shared server this long after its last session disconnects, unless configured. */
export const DEFAULT_SHARED_SERVER_LINGER_MS = 10 * 60_000;

const HOST_SCRIPT = fileURLToPath(new URL("shared-server-host.mjs", import.meta.url));
const HOST_START_TIMEOUT_MS = 10_000;
const HOST_POLL_INTERVAL_MS = 25;

/** A language server reached through a shared host, presented like a process's stdio. */
export interface LspSharedServer {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Local PID of the shared language server process. */
  readonly pid: number;
  /** Settles when the session is disconnected; exit code 0 only after stop(). */
  readonly completion: Promise<{ readonly exitCode: number | null }>;
  stop(): Promise<void>;
}

export interface LspSharedServerRequest {
  readonly serverId: string;
  readonly command: readonly string[];
  /** Working directory of a server this request starts. */
  readonly cwd: string;
  /** Configured environment overrides; part of the shared server configuration. */
  readonly configuredEnv: Readonly<Record<string, string>>;
  /** Complete environment of a server this request starts. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settings?: unknown;
  /** Initialize parameters; the root and initialization options select the shared server. */
  readonly initialize: Readonly<Record<string, unknown>>;
  readonly lingerMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Attach Pi sessions to shared language servers of the current user. */
export class LspSharedServers {
  private readonly _directory: string;

  constructor(options: { readonly directory?: string } = {}) {
    this._directory =
      options.directory ?? path.join(os.tmpdir(), `pi-agent-ide-lsp-${os.userInfo().uid}`);
  }

  /** Connect to the host for this configuration, starting it when none runs. */
  async attach(request: LspSharedServerRequest): Promise<LspSharedServer> {
    const key = sharedServerKey(request);
    const socketPath = await this._socketPath(key);
    let socket = await connect(socketPath, request.signal);
    if (!socket) {
      const host = startHost(socketPath, key, this._directory);
      socket = await waitForHost(socketPath, host, request.signal);
    }
    try {
      const reply = await exchange(
        socket,
        {
          protocol: SHARED_SERVER_PROTOCOL,
          key,
          command: request.command,
          cwd: request.cwd,
          env: request.env,
          settings: request.settings,
          initialize: request.initialize,
          lingerMs: request.lingerMs,
          timeoutMs: request.timeoutMs,
        },
        request.timeoutMs + HOST_START_TIMEOUT_MS,
        request.signal,
      );
      if (typeof reply.pid !== "number")
        throw new Error(
          typeof reply.error === "string" ? reply.error : "Shared language server did not attach",
        );
      return sharedServer(socket, reply.pid);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async _socketPath(key: string): Promise<string> {
    await mkdir(this._directory, { recursive: true, mode: 0o700 });
    if (process.platform === "win32")
      return `\\\\.\\pipe\\pi-agent-ide-lsp-${hash(os.userInfo().username)}-${key}`;
    const directory = await lstat(this._directory);
    if (
      !directory.isDirectory() ||
      directory.uid !== os.userInfo().uid ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error(`Shared language server directory is not private: ${this._directory}`);
    return path.join(this._directory, `${key}.sock`);
  }
}

/** Hash of everything that makes two sessions' servers interchangeable. */
function sharedServerKey(request: LspSharedServerRequest): string {
  return hash(
    JSON.stringify([
      SHARED_SERVER_PROTOCOL,
      request.serverId,
      request.command,
      request.configuredEnv,
      request.initialize.rootUri,
      request.initialize.initializationOptions ?? null,
      request.settings ?? null,
    ]),
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Start a detached host with the runtime that runs Pi. */
function startHost(socketPath: string, key: string, directory: string): ChildProcess {
  // A single-executable Pi cannot run scripts, so its host runs on the installed Node.js.
  const command = process.versions.bun || !singleExecutable() ? process.execPath : "node";
  // Runtime failures such as heap exhaustion are written here; a clean stop removes the file.
  const log = path.join(directory, `${key}.log`);
  keepFailureLog(log);
  const output = openSync(log, "w", 0o600);
  try {
    const host = spawn(command, [HOST_SCRIPT, socketPath, key, log], {
      cwd: directory,
      detached: true,
      env: hostEnvironment(),
      stdio: ["ignore", "ignore", output],
      windowsHide: true,
    });
    host.unref();
    return host;
  } finally {
    closeSync(output);
  }
}

/**
 * A log left with content records why the previous host for this key failed. Keep it under its own
 * name so the new host does not truncate it; the host sweep removes it after a day.
 */
function keepFailureLog(log: string): void {
  try {
    const { mtimeMs, size } = statSync(log);
    if (size > 0) renameSync(log, log.replace(/\.log$/u, `.${String(Math.round(mtimeMs))}.log`));
  } catch {
    // No earlier log.
  }
}

/**
 * The host outlives the session that starts it and runs only its own script, so it takes none
 * of that session's variables. NODE_OPTIONS in particular could preload code, open an
 * inspector port or change heap limits. Servers get each session's environment separately.
 */
function hostEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of HOST_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (process.versions.bun) environment.BUN_BE_BUN = "1";
  return environment;
}

const HOST_ENVIRONMENT = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "LANG",
];

function singleExecutable(): boolean {
  const sea = process.getBuiltinModule("node:sea") as { isSea?(): boolean } | undefined;
  return sea?.isSea?.() ?? false;
}

/** Connect, or report that no host listens on this socket. */
function connect(socketPath: string, signal?: AbortSignal): Promise<net.Socket | undefined> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      socket.on("error", () => void 0);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
  });
}

/** Wait until the started host, or another host that won the start race, listens. */
async function waitForHost(
  socketPath: string,
  host: ChildProcess,
  signal?: AbortSignal,
): Promise<net.Socket> {
  let failure: Error | undefined;
  host.once("error", (error) => (failure = error));
  host.once("exit", (code) => {
    // Exit code 0 means another host for this key already listens.
    if (code !== 0) failure = new Error(`Shared language server host exited with code ${code}`);
  });
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  for (;;) {
    if (failure) throw failure;
    const socket = await connect(socketPath, signal);
    if (socket) return socket;
    if (Date.now() > deadline) throw new Error("Shared language server host did not start");
    await new Promise((resolve) => setTimeout(resolve, HOST_POLL_INTERVAL_MS));
  }
}

/** Send the attach line and read the host's reply line, leaving later bytes on the socket. */
function exchange(
  socket: net.Socket,
  request: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ pid?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end === -1) return;
      finish();
      socket.pause();
      if (end + 1 < buffered.length) socket.unshift(buffered.subarray(end + 1));
      try {
        resolve(JSON.parse(buffered.subarray(0, end).toString("utf8")) as { pid?: unknown });
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      finish();
      reject(new Error("Shared language server host closed the connection"));
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("Shared language server attach timed out"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

function sharedServer(socket: net.Socket, pid: number): LspSharedServer {
  let stopped = false;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const stderr = new PassThrough();
  stderr.end();
  // Holds LSP bytes until the client's reader attaches; exchange() left the socket paused.
  const stdout = socket.pipe(new PassThrough());
  return {
    stdin: socket,
    stdout,
    stderr,
    pid,
    completion: closed.then(() => ({ exitCode: stopped ? 0 : 1 })),
    async stop() {
      stopped = true;
      socket.end();
      const timer = setTimeout(() => socket.destroy(), 1000);
      await closed;
      clearTimeout(timer);
    },
  };
}
