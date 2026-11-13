import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { SshTarget } from "./ssh.ts";
import { sshSecurityOptions } from "./ssh-transport.ts";

/** Sessions one master carries at once. OpenSSH servers refuse the 11th by default (MaxSessions). */
const MAX_SESSIONS = 8;
/** Masters per target. Long-lived channels hold sessions, so a busy target needs more than one. */
const MAX_MASTERS = 4;
/** A master exits this long after its last session ends, also when Pi died without stopping it. */
const IDLE_SECONDS = 60;
/** After a master failed to start, no new master starts for this long. */
const RETRY_MS = 30_000;
/** How long a process waits for a free session before it connects directly. */
const SLOT_WAIT_MS = 2000;
/** A master that has not authenticated by then is abandoned. */
const START_MS = 30_000;

/** OpenSSH options that send one process through a connection, and the release of its slot. */
export interface SshRoute {
  /** Empty for a direct connection. */
  readonly options: readonly string[];
  /** Call once the process has exited. Repeated calls have no effect. */
  release(): void;
  /** The end of the master's OpenSSH log, which says how the shared connection ended: a process
   * that goes through a master reports nothing about it. Empty for a direct connection. */
  masterDiagnostics(): string;
}

/** A new connection of its own, without a master. */
export const directSshRoute: SshRoute = { options: [], release() {}, masterDiagnostics: () => "" };

/** The master's log beside its socket. */
const logSuffix = ".log";
/** Enough of the log for the lines OpenSSH writes as the connection ends. */
const LOG_TAIL_BYTES = 4096;

interface Master {
  readonly socket: string;
  /** True once the master listens; false when it failed to start. */
  readonly ready: Promise<boolean>;
  started: boolean;
  /** Processes that use the master now. */
  sessions: number;
}

/** The masters of one OpenSSH destination. */
interface Pool {
  readonly target: SshTarget;
  readonly name: string;
  readonly members: Master[];
  /** Processes waiting for a free session, woken in order. */
  readonly waiters: (() => void)[];
  launched: number;
  failedAt?: number;
}

/** Undefined when the user's own configuration multiplexes or no private socket directory exists. */
const pools = new Map<string, Promise<Pool | undefined>>();
/** Distinguishes this load of the module: Pi loads extension modules anew on every reload. */
const instance = randomUUID();
const ownSocketsKey = Symbol.for("pi-agent-ide.ssh-master.own-sockets");
type GlobalWithSshMasters = typeof globalThis & {
  [ownSocketsKey]?: Map<string, SshTarget>;
};
let socketDirectory: Promise<string | undefined> | undefined;

/** Route a new SSH process through one of this Pi's masters for the target.
 * A process takes a free session of a running master, waits for a master that is starting, starts
 * another master when all are full, or waits briefly for a free session. It connects directly
 * when no master can start, all stay full, or the user multiplexes on their own.
 * Waiting ends with `signal` or after `waitMs`; the process then connects directly.
 */
export async function sshRoute(
  target: SshTarget,
  waitMs: number,
  signal?: AbortSignal,
): Promise<SshRoute> {
  // Windows OpenSSH has no connection multiplexing.
  if (process.platform === "win32") return directSshRoute;
  const deadline = Date.now() + waitMs;
  const key = `${target.host}\0${target.configFile ?? ""}`;
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = createPool(key, target);
    pools.set(key, pool);
  }
  const masters = await pool;
  if (masters === undefined) return directSshRoute;
  for (;;) {
    if (signal?.aborted) return directSshRoute;
    const free = masters.members.find((member) => member.started && member.sessions < MAX_SESSIONS);
    if (free !== undefined) {
      const route = take(masters, free);
      if (await listening(free.socket)) return route;
      // The master died or reached its idle timeout.
      route.release();
      remove(masters, free);
      continue;
    }
    const starting = masters.members.find((member) => !member.started);
    if (starting !== undefined) {
      if (!(await settled(starting.ready, deadline - Date.now(), signal))) return directSshRoute;
      continue;
    }
    const failedRecently =
      masters.failedAt !== undefined && Date.now() - masters.failedAt < RETRY_MS;
    if (masters.members.length < MAX_MASTERS && !failedRecently) {
      launchMember(masters);
      continue;
    }
    // Short requests free a session within moments; a long wait means long-lived channels hold them.
    const wait = Math.min(SLOT_WAIT_MS, deadline - Date.now());
    if (masters.members.length === 0 || wait <= 0 || !(await slot(masters, wait, signal)))
      return directSshRoute;
  }
}

/** Stop every master this process started and remove their sockets and logs. Safe to call
 * repeatedly. */
export function stopSshMasters(): void {
  const sockets = ownSockets();
  for (const [socket, target] of sockets) {
    // A master that exited by itself leaves its log behind.
    rmSync(`${socket}${logSuffix}`, { force: true });
    if (!existsSync(socket)) continue;
    spawnSync(
      "ssh",
      [
        ...sshSecurityOptions(target),
        "-o",
        `ControlPath=${socket}`,
        "-O",
        "exit",
        "--",
        target.host,
      ],
      { stdio: "ignore", timeout: 2000 },
    );
    // A master that died unnoticed leaves its socket behind.
    rmSync(socket, { force: true });
  }
  sockets.clear();
  pools.clear();
}

async function createPool(key: string, target: SshTarget): Promise<Pool | undefined> {
  // Respect a user's own ControlMaster/ControlPath; never override or share their socket.
  if (await userMultiplexes(target)) return undefined;
  const directory = await (socketDirectory ??= privateSocketDirectory());
  if (directory === undefined) return undefined;
  const name = path.join(
    directory,
    `${process.pid}-${createHash("sha256").update(`${instance}\0${key}`).digest("hex").slice(0, 16)}`,
  );
  return { target, name, members: [], waiters: [], launched: 0 };
}

function launchMember(pool: Pool): void {
  const socket = `${pool.name}-${pool.launched++}`;
  ownSockets().set(socket, pool.target);
  const member: Master = {
    socket,
    sessions: 0,
    started: false,
    ready: launch(pool.target, socket),
  };
  // Registered first, so the pool is updated before any waiter sees the result.
  void member.ready.then((ready) => {
    if (ready) member.started = true;
    else {
      pool.failedAt = Date.now();
      remove(pool, member);
    }
  });
  pool.members.push(member);
}

function take(pool: Pool, member: Master): SshRoute {
  member.sessions++;
  let released = false;
  return {
    options: ["-o", "ControlMaster=no", "-o", `ControlPath=${member.socket}`],
    masterDiagnostics: () => fileTail(`${member.socket}${logSuffix}`, LOG_TAIL_BYTES),
    release() {
      if (released) return;
      released = true;
      member.sessions--;
      pool.waiters.shift()?.();
    },
  };
}

function remove(pool: Pool, member: Master): void {
  const index = pool.members.indexOf(member);
  if (index >= 0) pool.members.splice(index, 1);
  ownSockets().delete(member.socket);
  void unlink(member.socket).catch(() => {});
  void unlink(`${member.socket}${logSuffix}`).catch(() => {});
}

/** The socket and target of every master this process started, shared by every load of this
 * module. Masters of an earlier load keep serving its open channels and stop at exit with the rest.
 * Socket names differ per load: a master removes its socket when it exits.
 */
function ownSockets(): Map<string, SshTarget> {
  const shared = globalThis as GlobalWithSshMasters;
  let sockets = shared[ownSocketsKey];
  if (sockets === undefined) {
    sockets = new Map();
    shared[ownSocketsKey] = sockets;
    process.once("exit", stopSshMasters);
  }
  return sockets;
}

/** Wait until a session of the pool ends; false after `waitMs` or an abort. */
function slot(pool: Pool, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  let wake: (() => void) | undefined;
  const freed = new Promise<boolean>((resolve) => {
    wake = () => resolve(true);
    pool.waiters.push(wake);
  });
  return settled(freed, waitMs, signal).finally(() => {
    const index = wake === undefined ? -1 : pool.waiters.indexOf(wake);
    if (index >= 0) pool.waiters.splice(index, 1);
  });
}

/** Start a backgrounded master; OpenSSH exits the foreground process once it is authenticated. */
async function launch(target: SshTarget, socket: string): Promise<boolean> {
  const log = `${socket}${logSuffix}`;
  await Promise.all([unlink(socket).catch(() => {}), unlink(log).catch(() => {})]);
  const child = spawn(
    "ssh",
    [
      ...sshSecurityOptions(target),
      "-o",
      "ControlMaster=yes",
      "-o",
      `ControlPath=${socket}`,
      "-o",
      `ControlPersist=${IDLE_SECONDS}`,
      // A dead network ends the master, and with it its sessions, within 15 s.
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      // The reason the shared connection ended, for the processes it carried.
      "-o",
      "LogLevel=VERBOSE",
      "-E",
      log,
      "-f",
      "-N",
      "--",
      target.host,
    ],
    // The backgrounded master inherits these descriptors; pipes would stay open with it.
    { stdio: "ignore" },
  );
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, START_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return exitCode === 0 && (await listening(socket));
}

async function userMultiplexes(target: SshTarget): Promise<boolean> {
  const output = await new Promise<string | undefined>((resolve) => {
    execFile(
      "ssh",
      [
        ...(target.configFile === undefined ? [] : ["-F", target.configFile]),
        "-G",
        "--",
        target.host,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
  // An unreadable configuration fails the same way for every process; stay out of the way.
  return output === undefined || multiplexingConfigured(output);
}

/** Whether `ssh -G` output shows the user's own ControlMaster or ControlPath. */
export function multiplexingConfigured(output: string): boolean {
  const options = new Map(
    output.split("\n").map((line) => {
      const [name = "", ...value] = line.trim().split(" ");
      return [name.toLowerCase(), value.join(" ")];
    }),
  );
  const controlPath = options.get("controlpath");
  return (
    (options.get("controlmaster") ?? "false") !== "false" ||
    (controlPath !== undefined && controlPath !== "none")
  );
}

/** A short directory only this user can use: Unix socket paths hold about 104 bytes. */
async function privateSocketDirectory(): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const directory = `/tmp/pi-ssh-${uid}`;
  try {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(directory);
    // Another user could have created the directory or a link in its place.
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) return undefined;
  } catch {
    return undefined;
  }
  await removeStaleSockets(directory);
  return directory;
}

/** Remove sockets that a Pi process which no longer runs left behind and nothing listens on,
 * and their logs. */
async function removeStaleSockets(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const owner = Number(/^(\d+)-[0-9a-f]{16}-\d+(?:\.log)?$/u.exec(name)?.[1]);
      if (!Number.isSafeInteger(owner) || owner === process.pid || running(owner)) return;
      const socket = path.join(directory, name);
      if (!(await listening(socket))) await unlink(socket).catch(() => {});
    }),
  );
}

/** The last `bytes` of a small local file; empty when it cannot be read. Synchronous, so a closing
 * channel can classify its loss before it settles. */
function fileTail(file: string, bytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const size = fstatSync(descriptor).size;
    const tail = Buffer.alloc(Math.min(size, bytes));
    readSync(descriptor, tail, 0, tail.length, size - tail.length);
    return tail.toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a master accepts connections on the socket; a local check without a round trip. */
function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 1000);
    connection.once("connect", () => finish(true));
    connection.once("error", () => finish(false));
  });
}

/** The promise's value, or false when `waitMs` passes or `signal` aborts first. */
async function settled(
  ready: Promise<boolean>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      ready,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        abort = () => resolve(false);
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
