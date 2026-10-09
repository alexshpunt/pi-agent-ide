import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { remoteLocation } from "./identity.js";
import { SshBackendError, type SshTarget, type BackendOperationContext } from "./ssh.js";
import {
  sshFailureCode,
  sshWorkerCommand,
  systemSshArguments,
  validateSshTarget,
} from "./ssh-transport.js";

const frameSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("ready"),
    pid: Type.Integer({ minimum: 1 }),
    identity: Type.Optional(Type.String({ pattern: "^[a-f0-9-]+:[0-9]+$" })),
  }),
  Type.Object({ kind: Type.Literal("ack"), id: Type.Integer({ minimum: 1 }) }),
  Type.Object({
    kind: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
    bytes: Type.String({ maxLength: 32768 }),
  }),
  Type.Object({ kind: Type.Literal("exit"), exitCode: Type.Integer() }),
  Type.Object({
    kind: Type.Literal("error"),
    code: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
    effect: Type.Union([Type.Literal("not-applied"), Type.Literal("unknown")]),
  }),
]);
type Frame = Static<typeof frameSchema>;

/** Service startup and optional remote terminal dimensions. */
export interface SshProcessContext extends BackendOperationContext {
  readonly pty?: { readonly cols: number; readonly rows: number };
}
/** Exact remote process streams. Drain both output streams while the channel is running. */
export interface SshProcessChannel {
  /** Canonical remote cwd and remote process leader, never the local SSH transport PID. */
  readonly source: string;
  readonly pid: number;
  /** Boot ID and start ticks captured from the child; absent when native metadata is unavailable. */
  readonly identity?: string;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<{ readonly exitCode: number }>;
  /** Deliver bytes in order; resolves only after the remote OS accepts all bytes. */
  write(bytes: Uint8Array): Promise<void>;
  /** Close remote stdin after all queued writes. */
  end(): Promise<void>;
  /** Resize a remote PTY; pipe channels reject this operation without changing the process. */
  resize(cols: number, rows: number): Promise<void>;
  /** Reap the owned group and report its actual exit. Cancellation still rejects completion. */
  stop(): Promise<{ readonly exitCode: number }>;
}

/** Start a transient framed channel. timeoutMs bounds startup, not the service lifetime. */
export async function startSshProcess(
  target: SshTarget,
  command: string,
  args: readonly string[],
  cwd: string,
  context: SshProcessContext = {},
): Promise<SshProcessChannel> {
  validateSshTarget(target);
  if (context.pty) validateDimensions(context.pty.cols, context.pty.rows);
  const source = remoteLocation(target.id, cwd).source;
  const timeout = context.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new TypeError("SSH startup deadline must be positive");
  context.signal?.throwIfAborted();
  const bootstrap = await sshWorkerCommand(new URL("./ssh-channel-worker.py", import.meta.url));
  context.signal?.throwIfAborted();
  const request = JSON.stringify({
    command,
    args,
    cwd,
    ...(context.pty ? { pty: context.pty } : {}),
  });
  // Initial argv is separate from the small interactive control frames.
  if (Buffer.byteLength(request) > 48 * 1024 * 1024)
    throw new SshBackendError("FRAME_LIMIT", source, "not-applied");
  const child = spawn("ssh", systemSshArguments(target, bootstrap), { stdio: "pipe" });
  const channel = new ProcessChannel(child, source, context.pty !== undefined, context.signal);
  const timer = setTimeout(() => channel.cancel("TIMEOUT"), timeout);
  try {
    await channel.sendInitial(request);
    await channel.ready;
    return channel;
  } finally {
    clearTimeout(timer);
  }
}

function validateDimensions(cols: number, rows: number): void {
  if (![cols, rows].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1000))
    throw new TypeError("PTY dimensions must be integers between 1 and 1000");
}
class ProcessChannel implements SshProcessChannel {
  readonly stdout = new PassThrough({ highWaterMark: 65536 });
  readonly stderr = new PassThrough({ highWaterMark: 65536 });
  readonly completion: Promise<{ readonly exitCode: number }>;
  readonly ready: Promise<void>;
  readonly #acks = new Map<number, { resolve(): void; reject(error: Error): void }>();
  readonly #blocked = new Set<PassThrough>();
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #resolveCompletion!: (result: { exitCode: number }) => void;
  #rejectCompletion!: (error: Error) => void;
  #buffer = Buffer.alloc(0);
  #diagnostics = "";
  #failure: string | undefined;
  #failureEffect: SshBackendError["effect"] | undefined;
  #requested = false;
  #started = false;
  #pid = 0;
  #identity: string | undefined;
  #closed = false;
  #ending = false;
  #stopping = false;
  #exitCode: number | undefined;
  #transportExit: number | null | undefined;
  #sequence = 0;
  #queuedBytes = 0;
  #queue: Promise<void> = Promise.resolve();
  #stopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly source: string,
    readonly pty: boolean,
    signal?: AbortSignal,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.completion = new Promise((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    // Callers may consume startup and completion at different times. Preserve rejection without
    // emitting an unhandled rejection before either promise is awaited.
    void this.ready.catch(() => {});
    void this.completion.catch(() => {});
    child.stdout.on("data", (bytes: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      this.parse();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (this.#diagnostics.length < 16384) this.#diagnostics += bytes.toString();
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      this.#failure = "DEPENDENCY_UNAVAILABLE";
    });
    const abort = () => this.cancel("CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", (exitCode) => {
      this.#closed = true;
      this.#transportExit = exitCode;
      clearTimeout(this.#stopTimer);
      signal?.removeEventListener("abort", abort);
      const code =
        this.#failure ??
        (exitCode !== 0
          ? sshFailureCode(exitCode, this.#diagnostics)
          : this.#exitCode === undefined
            ? "TRANSPORT_FAILED"
            : undefined);
      this.stdout.end();
      this.stderr.end();
      const inputError = this.error(code ?? "INPUT_CLOSED");
      for (const pending of this.#acks.values()) pending.reject(inputError);
      this.#acks.clear();
      if (code) {
        const error = this.error(code);
        this.#rejectReady(error);
        this.#rejectCompletion(error);
      } else if (this.#exitCode !== undefined) {
        this.#resolveCompletion({ exitCode: this.#exitCode });
      }
    });
    for (const stream of [this.stdout, this.stderr]) {
      const resume = (): void => {
        this.#blocked.delete(stream);
        this.parse();
        if (this.#blocked.size === 0) child.stdout.resume();
      };
      stream.on("drain", resume);
      stream.on("close", resume);
    }
    if (signal?.aborted) abort();
  }

  get pid(): number {
    return this.#pid;
  }
  get identity(): string | undefined {
    return this.#identity;
  }
  async sendInitial(request: string): Promise<void> {
    this.#requested = true;
    await this.sendLine(request);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed || this.#ending || this.#stopping) throw this.error("INPUT_CLOSED");
    if (this.#queuedBytes + bytes.length > 1024 * 1024) throw this.error("INPUT_LIMIT");
    const data = Buffer.from(bytes);
    this.#queuedBytes += data.length;
    const result = this.#queue.then(async () => {
      for (let offset = 0; offset < data.length; offset += 16384) {
        if (this.#stopping || this.#closed) throw this.error("INPUT_CLOSED");
        await this.sendAcknowledged({
          kind: "input",
          bytes: data.subarray(offset, offset + 16384).toString("base64"),
        });
      }
    });
    this.#queue = result.catch(() => {});
    try {
      await result;
    } finally {
      this.#queuedBytes -= data.length;
    }
  }

  async end(): Promise<void> {
    if (this.pty) throw new SshBackendError("PTY_INPUT_NOT_CLOSABLE", this.source, "not-applied");
    this.#ending = true;
    await this.#queue;
    await this.send({ kind: "end" });
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.pty) throw new SshBackendError("PTY_REQUIRED", this.source, "not-applied");
    validateDimensions(cols, rows);
    await this.sendAcknowledged({ kind: "resize", cols, rows });
  }
  stop(): Promise<{ readonly exitCode: number }> {
    if (!this.#closed && !this.#stopping) {
      this.#stopping = true;
      void this.send({ kind: "stop" }).catch(() => {});
      // A disconnected transport or undrained output must not keep the local SSH child alive.
      this.#stopTimer = setTimeout(() => {
        this.#failure ??= "TRANSPORT_FAILED";
        this.child.kill("SIGKILL");
      }, 5000);
      this.child.stdout.resume();
      this.stdout.resume();
      this.stderr.resume();
    }
    return this.completion.catch((error: unknown) => {
      // Only a clean SSH close and an actual native exit frame prove cancellation cleanup.
      if (
        this.#failure === "CANCELLED" &&
        this.#transportExit === 0 &&
        this.#exitCode !== undefined
      ) {
        return { exitCode: this.#exitCode };
      }
      throw error;
    });
  }

  cancel(code: string): void {
    if (this.#closed) return;
    this.#failure ??= code;
    void this.stop().catch(() => {});
  }

  private error(code: string): SshBackendError {
    const knownPreflightFailure = [
      "HOST_KEY_FAILED",
      "AUTH_FAILED",
      "DEPENDENCY_UNAVAILABLE",
    ].includes(code);
    const effect =
      this.#failureEffect ??
      (!this.#requested || knownPreflightFailure ? "not-applied" : "unknown");
    return new SshBackendError(code, this.source, effect);
  }

  private async sendAcknowledged(event: Readonly<Record<string, unknown>>): Promise<void> {
    const id = ++this.#sequence;
    const accepted = new Promise<void>((resolve, reject) => {
      this.#acks.set(id, { resolve, reject });
    });
    void accepted.catch(() => {});
    try {
      await this.send({ ...event, id });
      await accepted;
    } finally {
      this.#acks.delete(id);
    }
  }
  private async send(event: Readonly<Record<string, unknown>>): Promise<void> {
    await this.sendLine(JSON.stringify(event));
  }
  private sendLine(line: string): Promise<void> {
    if (this.#closed) return Promise.reject(this.error("INPUT_CLOSED"));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error) reject(this.error("INPUT_CLOSED"));
        else resolve();
      });
    });
  }

  private parse(): void {
    while (this.#blocked.size === 0) {
      const end = this.#buffer.indexOf(10);
      if (end < 0) {
        if (this.#buffer.length > 65536) this.cancel("FRAME_LIMIT");
        return;
      }
      if (end > 65536) {
        this.cancel("FRAME_LIMIT");
        return;
      }
      const line = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      let frame: unknown;
      try {
        frame = JSON.parse(line.toString("utf8"));
      } catch {
        this.cancel("INVALID_RESPONSE");
        return;
      }
      if (!Value.Check(frameSchema, frame)) {
        this.cancel("INVALID_RESPONSE");
        return;
      }
      this.receive(frame);
    }
    this.child.stdout.pause();
  }

  private receive(frame: Frame): void {
    if (frame.kind === "ready") {
      if (this.#started) {
        this.cancel("INVALID_RESPONSE");
        return;
      }
      this.#started = true;
      this.#pid = frame.pid;
      this.#identity = frame.identity;
      this.#resolveReady();
    } else if (frame.kind === "ack") {
      const pending = this.#acks.get(frame.id);
      if (!pending) {
        this.cancel("INVALID_RESPONSE");
        return;
      }
      this.#acks.delete(frame.id);
      pending.resolve();
    } else if (frame.kind === "exit") {
      this.#exitCode = frame.exitCode;
    } else if (frame.kind === "error") {
      this.#failure = frame.code;
      this.#failureEffect = frame.effect;
    } else {
      const bytes = Buffer.from(frame.bytes, "base64");
      if (bytes.toString("base64") !== frame.bytes) {
        this.cancel("INVALID_RESPONSE");
        return;
      }
      const stream = frame.kind === "stdout" ? this.stdout : this.stderr;
      // A closed consumer cannot drain. Discard its output, but still require the exit frame.
      if (!stream.destroyed && !stream.write(bytes)) this.#blocked.add(stream);
    }
  }
}
