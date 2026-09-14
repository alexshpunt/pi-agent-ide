import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import type { Readable, Writable } from "node:stream";

interface DapRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments?: unknown;
}

interface DapResponse {
  readonly seq: number;
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command: string;
  readonly message?: string;
  readonly body?: unknown;
}

export interface DapEvent {
  readonly seq: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: unknown;
}

export interface DapReverseRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments?: unknown;
}

type DapMessage = DapResponse | DapEvent | DapReverseRequest;
type ReverseRequestHandler = (request: DapReverseRequest) => Promise<unknown>;

interface PendingRequest {
  readonly resolve: (body: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

interface EventWaiter {
  readonly events: ReadonlySet<string>;
  readonly resolve: (event: DapEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Framed JSON client for one Debug Adapter Protocol transport. */
export class DapClient {
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #ownedProcess?: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #events: DapEvent[] = [];
  readonly #waiters = new Set<EventWaiter>();
  readonly #eventListeners = new Set<(event: DapEvent) => void>();
  #buffer = Buffer.alloc(0);
  #sequence = 1;
  #closedError: Error | undefined;
  #reverseRequestHandler: ReverseRequestHandler | undefined;
  /** Last stop payload, used to ignore identical duplicate events before execution resumes. */
  #lastStoppedEvent: string | undefined;

  private constructor(
    readable: Readable,
    writable: Writable,
    ownedProcess?: ChildProcessWithoutNullStreams,
  ) {
    this.#readable = readable;
    this.#writable = writable;
    this.#ownedProcess = ownedProcess;
    readable.on("data", (chunk: Buffer) => this.#consume(chunk));
    readable.once("error", (error) => this.#close(error));
    readable.once("close", () => this.#close(new Error("Debug adapter connection closed")));
    if (ownedProcess !== undefined) {
      ownedProcess.stderr.on("data", (chunk: Buffer) => {
        if (process.env.PI_DEBUG_DAP_TRACE === "1") process.stderr.write(chunk);
      });
      ownedProcess.once("error", (error) => this.#close(error));
      ownedProcess.once("exit", (code, signal) => {
        this.#close(
          new Error(
            `Debug adapter exited${code === null ? "" : ` with code ${code}`}${signal === null ? "" : ` (${signal})`}`,
          ),
        );
      });
    }
  }

  /** Start a debug adapter whose protocol is carried over stdin/stdout. */
  static start(command: string, args: readonly string[], cwd: string): DapClient {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new DapClient(child.stdout, child.stdin, child);
  }

  /** Adopt a connected DAP socket, optionally after an out-of-band initialize request. */
  static fromSocket(socket: net.Socket, nextSequence = 1): DapClient {
    const client = new DapClient(socket, socket);
    client.#sequence = nextSequence;
    return client;
  }

  /** Connect to a Debug Adapter Protocol TCP server. */
  static connect(port: number, host = "127.0.0.1"): Promise<DapClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      const fail = (error: Error): void => reject(error);
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        resolve(new DapClient(socket, socket));
      });
    });
  }

  /** Handle adapter-to-client requests such as js-debug startDebugging. */
  onReverseRequest(handler: ReverseRequestHandler): void {
    this.#reverseRequestHandler = handler;
  }

  /** Observe adapter events as soon as they arrive. */
  onEvent(listener: (event: DapEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Send one DAP request and resolve with its response body. */
  request<T = unknown>(
    command: string,
    arguments_?: unknown,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    if (options.signal?.aborted === true) {
      return Promise.reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Debug operation aborted"),
      );
    }
    if (["continue", "next", "stepIn", "stepOut"].includes(command)) {
      // Some adapters do not emit continued. Reset before sending because the next stop
      // may arrive before the response to this request.
      this.#lastStoppedEvent = undefined;
    }
    const seq = this.#sequence++;
    const message: DapRequest = {
      seq,
      type: "request",
      command,
      ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
    };
    const response = new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        this.#pending.delete(seq);
        cleanup();
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("Debug operation aborted"),
        );
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#pending.delete(seq);
          cleanup();
          reject(new Error(`Timed out waiting for debug response ${command}`));
        }, options.timeoutMs);
      }
      this.#pending.set(seq, { resolve: (body) => resolve(body as T), reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    this.#send(message);
    return response;
  }

  /** Wait for the next matching event, including an event already received. */
  waitForEvent(event: string, timeoutMs = 30_000): Promise<DapEvent> {
    return this.waitForAnyEvent([event], timeoutMs);
  }

  /** Wait for the next event whose name is in the supplied set. */
  waitForAnyEvent(
    events: readonly string[],
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<DapEvent> {
    const accepted = new Set(events);
    const queued = this.#events.findIndex((candidate) => accepted.has(candidate.event));
    if (queued >= 0) return Promise.resolve(this.#events.splice(queued, 1)[0] as DapEvent);
    if (this.#closedError !== undefined) return Promise.reject(this.#closedError);
    return new Promise<DapEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        events: accepted,
        resolve: (value) => {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for debug event ${events.join(" or ")}`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
      const abort = (): void =>
        waiter.reject(
          signal?.reason instanceof Error ? signal.reason : new Error("Debug operation aborted"),
        );
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Close the transport and any adapter process owned by this client. */
  close(): void {
    this.#readable.destroy();
    this.#writable.destroy();
    if (this.#ownedProcess !== undefined && !this.#ownedProcess.killed) this.#ownedProcess.kill();
    this.#close(new Error("Debug adapter closed"));
  }

  #send(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.#writable.write(
      Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]),
    );
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header);
      if (lengthMatch === null) {
        this.#close(new Error("Debug adapter sent a frame without Content-Length"));
        return;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      try {
        this.#handle(JSON.parse(body) as DapMessage);
      } catch (error) {
        this.#close(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #handle(message: DapMessage): void {
    if (message.type === "event") {
      if (message.event === "stopped") {
        const stoppedEvent = JSON.stringify(message.body ?? null);
        if (stoppedEvent === this.#lastStoppedEvent) return;
        this.#lastStoppedEvent = stoppedEvent;
      } else if (message.event === "continued") {
        this.#lastStoppedEvent = undefined;
      }
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.request_seq);
      if (pending === undefined) return;
      this.#pending.delete(message.request_seq);
      pending.cleanup();
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(`${message.command}: ${message.message ?? "failed"}`));
      return;
    }
    if (message.type === "event") {
      for (const listener of this.#eventListeners) listener(message);
      const waiter = [...this.#waiters].find((candidate) => candidate.events.has(message.event));
      if (waiter === undefined) this.#events.push(message);
      else waiter.resolve(message);
      return;
    }
    void this.#handleReverseRequest(message);
  }

  async #handleReverseRequest(request: DapReverseRequest): Promise<void> {
    try {
      if (this.#reverseRequestHandler === undefined)
        throw new Error(`Client does not support reverse request ${request.command}`);
      const body = await this.#reverseRequestHandler(request);
      this.#send({
        seq: this.#sequence++,
        type: "response",
        request_seq: request.seq,
        success: true,
        command: request.command,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      this.#send({
        seq: this.#sequence++,
        type: "response",
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #close(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
}
