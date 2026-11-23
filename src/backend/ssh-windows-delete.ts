import { createInterface } from "node:readline";

import { SshBackendError, type BackendOperationContext, type SshTarget } from "./ssh.ts";
import { startSshProcess, type SshProcessChannel } from "./ssh-channel.ts";
import { neutralDirectory, remotePython, sshWorkerBundle } from "./ssh-transport.ts";

const MAX_REPLY_BYTES = 48 * 1024 * 1024;
const RECEIPT_GRACE_MS = 2000;

/** One transient worker for the fresh probes and final mutation of a single Windows Delete. */
export class WindowsDeleteWorker {
  static async start(target: SshTarget, source: string, context: BackendOperationContext) {
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const channel = await startSshProcess(
      target,
      remotePython(await sshWorkerBundle("windows", "file")),
      ["windows-delete"],
      neutralDirectory(target),
      { ...context, signal },
    ).catch((error: unknown) => {
      if (!(error instanceof SshBackendError)) throw error;
      throw new SshBackendError(error.code, source, "not-applied", {
        cause: error,
        connection: error.connection,
      });
    });
    return new WindowsDeleteWorker(channel, controller, signal);
  }

  readonly #lines;
  readonly #replies;
  #queue = Promise.resolve();

  private constructor(
    private readonly channel: SshProcessChannel,
    private readonly controller: AbortController,
    private readonly signal: AbortSignal,
  ) {
    this.#lines = createInterface({ input: channel.stdout, crlfDelay: Infinity });
    this.#replies = this.#lines[Symbol.asyncIterator]();
    channel.stderr.resume();
  }

  request(
    input: Readonly<Record<string, unknown>>,
    source: string,
    mutation: boolean,
    timeoutMs: number,
  ): Promise<string> {
    // The policy issues independent reads concurrently. Only one reply is in flight, so replies
    // cannot cross even when one probe is refused and the policy falls back to other probes.
    const reply = this.#queue.then(() => this.exchange(input, source, mutation, timeoutMs));
    this.#queue = reply.then(
      () => undefined,
      () => undefined,
    );
    return reply;
  }

  private async exchange(
    input: Readonly<Record<string, unknown>>,
    source: string,
    mutation: boolean,
    timeoutMs: number,
  ): Promise<string> {
    if (this.signal.aborted) throw new SshBackendError("CANCELLED", source, "not-applied");
    const effect = mutation ? "unknown" : "not-applied";
    const timeout = new SshBackendError("TIMEOUT", source, effect);
    const timer = setTimeout(() => this.controller.abort(timeout), timeoutMs);
    let bytes = 0;
    const boundReply = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES)
        this.controller.abort(new SshBackendError("CONTENT_LIMIT", source, effect));
    };
    this.channel.stdout.on("data", boundReply);
    try {
      // Reserve time to return a native timeout receipt before the controller stops the job.
      const budgetMs = Math.max(0, timeoutMs - RECEIPT_GRACE_MS);
      await this.channel.write(Buffer.from(`${JSON.stringify({ ...input, budgetMs })}\n`));
      const reply = await this.#replies.next();
      if (reply.done) {
        await this.channel.completion;
        throw new SshBackendError("INVALID_RESPONSE", source, effect);
      }
      this.controller.signal.throwIfAborted();
      return reply.value;
    } catch (error) {
      this.controller.signal.throwIfAborted();
      if (!(error instanceof SshBackendError)) throw error;
      throw new SshBackendError(error.code, source, effect, {
        cause: error,
        connection: error.connection,
      });
    } finally {
      this.channel.stdout.off("data", boundReply);
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.#lines.close();
    // stop() reaps the owned job. An already-reported transport failure must not override a
    // confirmed operation receipt or change a classified policy refusal into a cleanup error.
    await this.channel.stop().catch(() => undefined);
  }
}
