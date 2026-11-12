import type { Readable } from "node:stream";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { remoteLocation } from "./identity.ts";
import { SshBackendError, type BackendOperationContext, type SshTarget } from "./ssh.ts";
import { startSshProcess } from "./ssh-channel.ts";
import { neutralDirectory, remotePython, sshWorkerBundle, targetOs } from "./ssh-transport.ts";

/** The worker's STREAM_CHUNK; a longer chunk is a protocol violation. */
const MAX_CHUNK_BYTES = 1024 * 1024;
const LINE_LIMIT = 64 * 1024;
const revisionPattern = "^[a-f0-9]{64}$";
const headerSchema = Type.Object({
  size: Type.Integer({ minimum: 0 }),
  revision: Type.String({ pattern: revisionPattern }),
  offset: Type.Integer({ minimum: 0 }),
  length: Type.Integer({ minimum: 0 }),
});

/** The byte window to stream and the revision it must keep. */
export interface SshStreamWindow {
  /** Required file revision; omit it to stream whatever the target opens. */
  readonly revision?: string;
  /** First byte; a negative offset counts from the end. Both clamp to the file. */
  readonly offset?: number;
  /** Maximum bytes; omit it to stream to the end. */
  readonly limit?: number;
}

/** What a stream sent: the window's position and length within the file and their checksum. */
export interface SshStreamResult {
  readonly size: number;
  readonly revision: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}
const failureSchema = Type.Object({
  ok: Type.Literal(false),
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
});
const completionSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({ sha256: Type.String({ pattern: revisionPattern }) }),
});

/** Pull exact byte counts and lines from a stream, keeping its backpressure. */
class ByteReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #chunks: Buffer[] = [];
  #length = 0;

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  /** Exactly `count` bytes, or undefined when the stream ends first. */
  async exactly(count: number): Promise<Buffer | undefined> {
    while (this.#length < count) if (!(await this.#fill())) return undefined;
    const joined = this.#take();
    this.#keep(joined.subarray(count));
    return joined.subarray(0, count);
  }

  /** One line without its newline, or undefined when the stream ends or the line is too long. */
  async line(): Promise<string | undefined> {
    for (;;) {
      const joined = this.#take();
      const end = joined.indexOf(10);
      if (end >= 0) {
        this.#keep(joined.subarray(end + 1));
        return joined.subarray(0, end).toString("utf8");
      }
      this.#keep(joined);
      if (joined.length > LINE_LIMIT || !(await this.#fill())) return undefined;
    }
  }

  async #fill(): Promise<boolean> {
    const next = await this.#iterator.next();
    if (next.done === true) return false;
    this.#chunks.push(next.value);
    this.#length += next.value.length;
    return true;
  }
  #take(): Buffer {
    const [only] = this.#chunks;
    const joined =
      this.#chunks.length === 1 && only !== undefined ? only : Buffer.concat(this.#chunks);
    this.#chunks = [];
    this.#length = 0;
    return joined;
  }
  #keep(rest: Buffer): void {
    if (rest.length === 0) return;
    this.#chunks.push(rest);
    this.#length += rest.length;
  }
}

function parsed(line: string | undefined): unknown {
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Stream a byte window of a remote regular file through one SSH channel.
 * The file must keep its revision, and `window.revision` when given, until the last byte.
 * `consume` gets the bytes in order, in chunks of at most 1 MiB; its promise paces the stream.
 * The target rechecks the revision after the last byte. A read has no effect on the target, so
 * every failure is not-applied; `consume` failures propagate unchanged.
 */
export async function readSshFileStream(
  target: SshTarget,
  filePath: string,
  window: SshStreamWindow,
  consume: (bytes: Buffer) => Promise<void>,
  context: BackendOperationContext = {},
): Promise<SshStreamResult> {
  const source = remoteLocation(target.id, filePath, targetOs(target)).source;
  const program = await sshWorkerBundle(targetOs(target), "file");
  const channel = await startSshProcess(
    target,
    remotePython(program),
    [],
    neutralDirectory(target),
    context,
  );
  channel.completion.catch(() => {});
  channel.stderr.resume();
  // An ended or malformed stream reports the channel's own failure when it has one.
  const broken = async (): Promise<never> => {
    let failure: unknown;
    channel.stdout.destroy();
    try {
      await channel.stop();
    } catch (error) {
      failure = error;
    }
    if (failure instanceof SshBackendError)
      throw new SshBackendError(failure.code, source, "not-applied", { cause: failure });
    throw new SshBackendError("INVALID_RESPONSE", source, "not-applied");
  };
  try {
    await channel.write(
      Buffer.from(JSON.stringify({ operation: "stream", path: filePath, ...window })),
    );
    await channel.end();
    const reader = new ByteReader(channel.stdout);
    const header = parsed(await reader.line());
    if (Value.Check(failureSchema, header))
      throw new SshBackendError(header.code, source, "not-applied");
    if (!Value.Check(headerSchema, header) || header.offset + header.length > header.size)
      return await broken();
    if (window.revision !== undefined && header.revision !== window.revision)
      throw new SshBackendError("CONFLICT", source, "not-applied");
    let sent = 0;
    for (;;) {
      const prefix = await reader.exactly(4);
      if (prefix === undefined) return await broken();
      const length = prefix.readUInt32BE(0);
      if (length === 0) break;
      if (length > MAX_CHUNK_BYTES || sent + length > header.length) return await broken();
      const bytes = await reader.exactly(length);
      if (bytes === undefined) return await broken();
      sent += length;
      await consume(bytes);
    }
    const reply = parsed(await reader.line());
    if (Value.Check(failureSchema, reply))
      throw new SshBackendError(reply.code, source, "not-applied");
    if (!Value.Check(completionSchema, reply) || sent !== header.length) return await broken();
    const { exitCode } = await channel.completion;
    if (exitCode !== 0) throw new SshBackendError("REMOTE_OPERATION_FAILED", source, "not-applied");
    return {
      size: header.size,
      revision: header.revision,
      offset: header.offset,
      length: header.length,
      sha256: reply.data.sha256,
    };
  } finally {
    // A stopped reader leaves output undrained; a closed consumer lets the channel discard it.
    channel.stdout.destroy();
    await channel.stop().catch(() => {});
  }
}
