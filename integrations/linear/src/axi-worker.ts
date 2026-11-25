import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Socket } from "node:net";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Client for the backend's long-lived `worker.js`, which runs AXI commands in one process.
 *
 * Starting `linear-axi` costs about a second of module loading per command, and one typed
 * Write runs several commands. A worker per backend script and working directory keeps the
 * modules loaded. Backends without a worker script, such as test doubles, keep the
 * one-process-per-command path: every function here returns `undefined` for them.
 */

/** Output of one command that ran to completion in the worker. */
export interface AxiWorkerOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface AxiWorkerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** The command's output exceeded `maxBytes`; the worker stopped it. */
export const AXI_WORKER_OUTPUT_TOO_LARGE = "LINEAR_AXI_OUTPUT_TOO_LARGE";

interface Pending {
  readonly resolve: (value: AxiWorkerOutput | undefined) => void;
  readonly reject: (error: unknown) => void;
}

const IDLE_MS = 5 * 60_000;
const workers = new Map<string, AxiWorker>();

class AxiWorker {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private buffer = "";
  private idle?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly key: string,
    readonly version: string,
    script: string,
    cwd: string,
  ) {
    const environment = { ...process.env };
    delete environment.LINEAR_AXI_AUTH_EPOCH;
    delete environment.LINEAR_AXI_CONNECTION_ID;
    // stderr is discarded like the one-shot path: it may contain a credential.
    this.child = spawn(process.execPath, [script], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.release();
  }

  run(
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: AxiWorkerOptions,
  ): Promise<AxiWorkerOutput | undefined> {
    const { signal, timeoutMs, maxBytes } = options;
    signal?.throwIfAborted();
    const id = this.next++;
    return new Promise<AxiWorkerOutput | undefined>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        this.release();
      };
      const cancel = (error: unknown) => {
        settle();
        this.send({ id, cancel: true });
        reject(error);
      };
      const abort = () => cancel(signal?.reason);
      const timer = setTimeout(() => cancel(new Error("LINEAR_AXI_TIMEOUT")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.hold();
      this.send({ id, args, cwd, env, maxBytes });
    });
  }

  /** Let the worker finish what it has and exit; later commands start a new one. */
  retire(): void {
    if (workers.get(this.key) === this) workers.delete(this.key);
    clearTimeout(this.idle);
    this.stopped = true;
    this.child.stdin.end();
  }

  private send(message: Record<string, unknown>): void {
    if (this.stopped) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    // A JSON-escaped reply can be several times longer than the command's output bound.
    if (this.buffer.length > 64 * 1024 * 1024) return this.fail(true);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let reply: unknown;
      try {
        reply = JSON.parse(line);
      } catch {
        return this.fail(true);
      }
      if (
        typeof reply !== "object" ||
        reply === null ||
        !("id" in reply) ||
        typeof reply.id !== "number" ||
        !Number.isInteger(reply.id)
      )
        return this.fail(true);
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      if ("unsupported" in reply && reply.unsupported === true) pending.resolve(undefined);
      else if ("overflow" in reply && reply.overflow === true)
        pending.reject(new Error(AXI_WORKER_OUTPUT_TOO_LARGE));
      else if (
        "stdout" in reply &&
        typeof reply.stdout === "string" &&
        "exitCode" in reply &&
        typeof reply.exitCode === "number" &&
        Number.isInteger(reply.exitCode)
      )
        pending.resolve({ stdout: reply.stdout, exitCode: reply.exitCode });
      else return this.fail(true);
    }
  }

  /** A worker that exits or breaks the protocol fails every command it still owed. */
  private fail(kill = false): void {
    if (workers.get(this.key) === this) workers.delete(this.key);
    clearTimeout(this.idle);
    this.stopped = true;
    if (kill) this.child.kill();
    for (const pending of [...this.pending.values()])
      pending.reject(new Error("LINEAR_AXI_FAILED"));
  }

  /** Keep Pi's event loop alive only while a command is in flight. */
  private hold(): void {
    clearTimeout(this.idle);
    this.child.ref();
    const { stdout } = this.child;
    if (stdout instanceof Socket) stdout.ref();
  }

  private release(): void {
    if (this.pending.size > 0 || this.stopped) return;
    this.child.unref();
    const { stdout } = this.child;
    if (stdout instanceof Socket) stdout.unref();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.retire(), IDLE_MS);
    this.idle.unref();
  }
}

/** The backend's worker script and its build version, when the backend ships one. */
async function workerScript(
  executable: string,
): Promise<{ readonly path: string; readonly version: string } | undefined> {
  if (!/\.[cm]?js$/u.test(executable)) return undefined;
  const script = path.join(path.dirname(executable), "worker.js");
  try {
    const info = await stat(script);
    return info.isFile() ? { path: script, version: `${info.mtimeMs}:${info.size}` } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one AXI command in the backend's worker. Resolves `undefined` when the backend has no
 * worker or the worker does not run these arguments; the caller then starts the CLI itself.
 * Rejects with `LINEAR_AXI_TIMEOUT`, the abort reason, `AXI_WORKER_OUTPUT_TOO_LARGE`, or
 * `LINEAR_AXI_FAILED` when the worker exits before it answers.
 */
export async function runAxiWorker(
  executable: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: AxiWorkerOptions,
): Promise<AxiWorkerOutput | undefined> {
  const script = await workerScript(executable);
  if (!script) return undefined;
  options.signal?.throwIfAborted();
  // One worker per working directory keeps paths relative to it resolving as they would in
  // a CLI started there.
  const key = `${script.path}\0${path.resolve(cwd)}`;
  let worker = workers.get(key);
  if (worker && worker.version !== script.version) {
    // A rebuilt backend takes effect for the next command, as it would for a new process.
    worker.retire();
    worker = undefined;
  }
  if (!worker) {
    worker = new AxiWorker(key, script.version, script.path, cwd);
    workers.set(key, worker);
  }
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) output[name] = value;
  return worker.run(args, cwd, output, options);
}

/** Stop every worker; used by tests and on shutdown. */
export function stopAxiWorkers(): void {
  for (const worker of [...workers.values()]) worker.retire();
}
