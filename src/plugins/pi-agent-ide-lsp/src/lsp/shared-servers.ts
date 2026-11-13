import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

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

/** The host script and the local modules it imports, entry first. */
const HOST_MODULES = ["shared-server-host.mjs", "server-request-handlers.mjs"] as const;
const HOST_SCRIPT = HOST_MODULES[0];
/**
 * A running Pi keeps the code it loaded, but a host it starts later would run whatever is on disk
 * then, possibly a newer version with another protocol. So the host's own modules are read when
 * this module loads, and each start runs that copy. A failed read surfaces at the first attach.
 */
const hostSources = readHostSources();

function readHostSources(): readonly string[] | Error {
  try {
    // Synchronous, so the copy is complete once this module has loaded.
    return HOST_MODULES.map((name) => readFileSync(new URL(name, import.meta.url), "utf8"));
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
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
      options.directory ?? path.join(os.tmpdir(), `pi-agent-ide-lsp-${currentUid()}`);
  }

  /** Connect to the host for this configuration, starting it when none runs. */
  async attach(request: LspSharedServerRequest): Promise<LspSharedServer> {
    const host = loadedHost();
    const key = sharedServerKey(request, host.version);
    const socketPath = await this._socketPath(key);
    let socket = await connect(socketPath, request.signal);
    if (!socket) {
      const script = await writeHost(this._directory, host);
      const started = startHost(script, socketPath, key, this._directory);
      socket = await waitForHost(socketPath, started, request.signal);
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
      return `\\\\.\\pipe\\pi-agent-ide-lsp-${hash(currentUserName())}-${key}`;
    const directory = await lstat(this._directory);
    if (
      !directory.isDirectory() ||
      directory.uid !== currentUid() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error(`Shared language server directory is not private: ${this._directory}`);
    return path.join(this._directory, `${key}.sock`);
  }
}

/** Hash of everything that makes two sessions' servers interchangeable. */
function sharedServerKey(request: LspSharedServerRequest, hostVersion: string): string {
  return hash(
    JSON.stringify([
      SHARED_SERVER_PROTOCOL,
      hostVersion,
      request.serverId,
      request.command,
      request.configuredEnv,
      request.initialize.rootUri,
      request.initialize.initializationOptions ?? null,
      request.settings ?? null,
    ]),
  );
}

/** Numeric id of the process's user; it needs no account entry, unlike `os.userInfo()`. */
function currentUid(): number {
  return process.getuid?.() ?? -1;
}

/** Name of the process's user, with a stable fallback when the account entry is missing. */
function currentUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || "unknown";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** The host this module loaded and the packages it imports. */
interface LoadedHost {
  readonly sources: readonly string[];
  /** Root directory of each package the host imports, by package name. */
  readonly packages: ReadonlyMap<string, string>;
  /** Hash of the sources and package locations; hosts of different versions never share a key. */
  readonly version: string;
}

function loadedHost(): LoadedHost {
  if (hostSources instanceof Error) throw hostSources;
  const sources = hostSources;
  const resolve = createRequire(new URL(HOST_SCRIPT, import.meta.url));
  const packages = new Map(
    [...new Set(sources.flatMap(packageImports))]
      .toSorted()
      .map((name) => [name, packageRoot(name, resolve.resolve(name))] as const),
  );
  return { sources, packages, version: hash(JSON.stringify([sources, [...packages]])) };
}

/** Names of the packages a module imports; Node built-ins and relative imports are not packages. */
function packageImports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"'.][^"']*)["']/gu)]
    .map(([, specifier = ""]) => specifier)
    .filter((specifier) => !specifier.startsWith("node:"))
    .map((specifier) => {
      const parts = specifier.split("/");
      return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
    });
}

/** The directory of the package that contains a file resolved from it. */
function packageRoot(name: string, entry: string): string {
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === name) return directory;
    } catch {
      // Not a package root.
    }
    if (path.dirname(directory) === directory)
      throw new Error(`Shared language server host package not found: ${name}`);
  }
}

/**
 * Write the loaded host into the private directory, named by its version, with links to the
 * packages it imports, and return its script. Concurrent sessions may write the same version;
 * the first complete copy wins. Hosts remove copies that no start has used for a day.
 */
async function writeHost(directory: string, host: LoadedHost): Promise<string> {
  const target = path.join(directory, `host-${host.version}`);
  const script = path.join(target, HOST_SCRIPT);
  const present = async () => {
    try {
      await stat(script);
      const now = new Date();
      await utimes(target, now, now);
      return true;
    } catch {
      return false;
    }
  };
  if (await present()) return script;
  const staging = await mkdtemp(path.join(directory, "staging-"));
  try {
    await Promise.all(
      HOST_MODULES.map((name, index) =>
        writeFile(path.join(staging, name), host.sources[index] ?? ""),
      ),
    );
    for (const [name, root] of host.packages) {
      const link = path.join(staging, "node_modules", name);
      await mkdir(path.dirname(link), { recursive: true });
      // A junction needs no privilege on Windows; other systems ignore the type.
      await symlink(root, link, "junction");
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (!(await present())) throw error;
  }
  return script;
}

/** Start a detached host with the runtime that runs Pi. */
function startHost(
  script: string,
  socketPath: string,
  key: string,
  directory: string,
): ChildProcess {
  // A single-executable Pi cannot run scripts, so its host runs on the installed Node.js.
  const command = process.versions.bun || !singleExecutable() ? process.execPath : "node";
  // Runtime failures such as heap exhaustion are written here; a clean stop removes the file.
  const log = path.join(directory, `${key}.log`);
  keepFailureLog(log);
  const output = openSync(log, "w", 0o600);
  try {
    const host = spawn(command, [script, socketPath, key, log], {
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
