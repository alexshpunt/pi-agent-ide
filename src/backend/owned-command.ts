import { startSshProcess, type SshProcessChannel } from "./ssh-channel.js";
import { SshBackendError, type SshTarget } from "./ssh.js";

/** Bounds for one owned, buffered command. Both output streams share the byte budget. */
export interface OwnedCommandOptions {
  readonly signal?: AbortSignal;
  /** A read refusal has no user-file effect; an interrupted mutating command may already have written. */
  readonly effect: "not-applied" | "unknown";
  readonly closeInput?: boolean;
  /** Optional exact stdin payload. It is sent in bounded chunks, then closed. */
  readonly input?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Preserve the caller's existing output-limit error code. */
  readonly limitCode?: "BYTE_LIMIT" | "CONTENT_LIMIT";
}

/** Run only the owning target's service and await native cleanup on success, refusal or cancellation. */
export async function runOwnedSshCommand(
  target: SshTarget,
  command: string,
  args: readonly string[],
  source: string,
  options: OwnedCommandOptions,
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0
  )
    throw new TypeError("Owned command deadlines and byte limits must be positive");
  options.signal?.throwIfAborted();
  const bounds = new AbortController();
  const operationSignal = options.signal
    ? AbortSignal.any([options.signal, bounds.signal])
    : bounds.signal;
  const timer = setTimeout(
    () => bounds.abort(new SshBackendError("TIMEOUT", source, options.effect)),
    options.timeoutMs,
  );
  let channel: SshProcessChannel | undefined;
  let failure: unknown;
  let result: { stdout: Buffer; stderr: Buffer; exitCode: number } | undefined;
  try {
    channel = await startSshProcess(target, command, args, target.workspace, {
      signal: operationSignal,
      timeoutMs: options.timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let length = 0;
    const consume = (bytes: Buffer, chunks: Buffer[]) => {
      length += bytes.length;
      if (length > options.maxBytes)
        bounds.abort(
          new SshBackendError(options.limitCode ?? "BYTE_LIMIT", source, options.effect),
        );
      else chunks.push(bytes);
    };
    channel.stdout.on("data", (bytes: Buffer) => consume(bytes, stdout));
    channel.stderr.on("data", (bytes: Buffer) => consume(bytes, stderr));
    if (options.input !== undefined) {
      for (let offset = 0; offset < options.input.length; offset += 65536)
        await channel.write(options.input.subarray(offset, offset + 65536));
    }
    if (options.closeInput || options.input !== undefined) {
      try {
        await channel.end();
      } catch (error) {
        // A completed program may close unused stdin before EOF arrives. Payload writes
        // above still require acknowledgements; only native completion below proves exit.
        if (!(error instanceof SshBackendError) || error.code !== "INPUT_CLOSED") throw error;
      }
    }
    const { exitCode } = await channel.completion;
    result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode };
  } catch (error) {
    const outcome: unknown = bounds.signal.aborted ? bounds.signal.reason : error;
    failure =
      outcome instanceof SshBackendError &&
      (outcome.source !== source ||
        (outcome.effect === "unknown" && options.effect === "not-applied"))
        ? new SshBackendError(
            outcome.code,
            source,
            outcome.effect === "not-applied" ? "not-applied" : options.effect,
            { cause: outcome },
          )
        : outcome;
  } finally {
    clearTimeout(timer);
  }
  try {
    await channel?.stop();
  } catch (cleanupError) {
    if (result === undefined)
      throw new AggregateError([failure, cleanupError], "Target command and cleanup failed", {
        cause: cleanupError,
      });
    throw cleanupError;
  }
  if (result === undefined) throw failure;
  return result;
}
