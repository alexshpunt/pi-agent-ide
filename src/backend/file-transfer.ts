import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileOperationInput } from "pi-agent-text-editor/api/plugin-protocol";
import { localObjectMode } from "pi-agent-text-editor/api/plugin-protocol";
import type { ResourceResolverContext } from "pi-agent-resource";
import type { SshBackendRegistry } from "./registry.ts";
import { SshBackendError } from "./ssh.ts";
import { checkCapturedRevision } from "./file-revision.ts";
import { startSshProcess, type SshProcessChannel } from "./ssh-channel.ts";
import { neutralDirectory, remotePython, sshTransferProgram, targetOs } from "./ssh-transport.ts";

const CHUNK_BYTES = 1024 * 1024;
/** A transfer fails once no bytes move for this long. Its total duration is unbounded. */
export const TRANSFER_STALL_MS = 30_000;

/** A failed transfer that tells how many bytes reached the destination and whether it changed. */
export class SshTransferError extends SshBackendError {
  constructor(
    code: string,
    source: string,
    readonly target: string,
    effect: SshBackendError["effect"],
    readonly transferredBytes: number,
    readonly totalBytes: number,
    options?: { readonly cause: SshBackendError },
  ) {
    super(code, source, effect, options);
    const reason =
      code === "TRANSFER_STALLED" ? `no data moved for ${TRANSFER_STALL_MS / 1000} s; ` : "";
    const state =
      effect === "not-applied"
        ? "the target file was not changed"
        : "the target file may have changed, check it before retrying";
    this.message = `${code}: ${source} to ${target}: ${reason}wrote ${transferredBytes} of ${totalBytes} bytes before the failure; ${state}`;
  }
}

/** Resolve an explicit local transfer endpoint, rejecting unowned URI schemes. */
export function localTransferSource(source: string, cwd: string): string {
  if (source.startsWith("file:")) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
    }
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source))
    throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
  if (cwd.startsWith("ssh://"))
    throw new SshBackendError("UNSUPPORTED_SOURCE", source, "not-applied");
  return path.resolve(cwd, source);
}

function localRevision(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.uid,
    info.gid,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
}
async function localEntry(source: string) {
  const entry = await lstat(source, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new SshBackendError("INVALID_FILE_TYPE", source, "not-applied");
  if (entry.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SshBackendError("CONTENT_LIMIT", source, "not-applied");
  return entry;
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function errorCode(error: unknown): string {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]*$/u.test(error.code)
    ? error.code
    : "TRANSFER_FAILED";
}

async function prepareTransfer(
  registry: SshBackendRegistry,
  input: FileOperationInput,
  context: ResourceResolverContext,
  captured?: ReadonlyMap<string, string | null>,
) {
  context.signal?.throwIfAborted();
  const remoteSource = registry.resolve(input.path, context.cwd);
  const remoteTarget = registry.resolve(input.target ?? "", context.cwd);
  const source = remoteSource?.location.source ?? localTransferSource(input.path, context.cwd);
  const target =
    remoteTarget?.location.source ?? localTransferSource(input.target ?? "", context.cwd);
  if (source === target) throw new SshBackendError("SAME_FILE", source, "not-applied");
  const sourceInfo = remoteSource
    ? await remoteSource.backend.lstat(remoteSource.location.path, context)
    : await localEntry(source);
  if ("kind" in sourceInfo && sourceInfo.kind !== "file")
    throw new SshBackendError("INVALID_FILE_TYPE", source, "not-applied");
  const size = Number(sourceInfo.size);
  const mode = "kind" in sourceInfo ? sourceInfo.mode : localObjectMode(sourceInfo);
  const sourceRevision = "revision" in sourceInfo ? sourceInfo.revision : localRevision(sourceInfo);
  checkCapturedRevision(source, sourceRevision, captured);
  let targetInfo;
  try {
    targetInfo = remoteTarget
      ? await remoteTarget.backend.lstat(remoteTarget.location.path, context)
      : await localEntry(target);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (targetInfo !== undefined) {
    if ("kind" in targetInfo && targetInfo.kind !== "file")
      throw new SshBackendError("INVALID_FILE_TYPE", target, "not-applied");
    checkCapturedRevision(
      target,
      "revision" in targetInfo ? targetInfo.revision : localRevision(targetInfo),
      captured,
    );
    if (
      remoteSource &&
      remoteTarget &&
      remoteSource.backend.target.host === remoteTarget.backend.target.host &&
      remoteSource.backend.target.configFile === remoteTarget.backend.target.configFile &&
      "identity" in sourceInfo &&
      "identity" in targetInfo &&
      sourceInfo.identity.device === targetInfo.identity.device &&
      sourceInfo.identity.inode === targetInfo.identity.inode
    )
      throw new SshBackendError("SAME_FILE", source, "not-applied");
  }
  const targetRevision =
    targetInfo === undefined
      ? null
      : "revision" in targetInfo
        ? targetInfo.revision
        : localRevision(targetInfo);
  if (targetInfo === undefined) checkCapturedRevision(target, null, captured);
  return { source, target, remoteSource, remoteTarget, size, mode, sourceRevision, targetRevision };
}

/** Check transfer endpoints without creating staging files or changing either endpoint. */
export async function validateTransferFile(
  registry: SshBackendRegistry,
  input: FileOperationInput,
  context: ResourceResolverContext,
): Promise<void> {
  await prepareTransfer(registry, input, context);
}
/** Stream original bytes across backend boundaries, checking both endpoints before publication.
 * A cross-backend move deletes its source only after the destination acknowledges its checksum.
 * Publication and source removal are separate effects; failed removal is reported as unknown.
 * Object callers can recheck their approved leaf metadata before staging and publication.
 */
export async function transferFile(
  registry: SshBackendRegistry,
  operation: "copy" | "move",
  input: FileOperationInput,
  context: ResourceResolverContext,
  captured?: ReadonlyMap<string, string | null>,
  verifyApprovedEntries?: () => Promise<void>,
): Promise<{ readonly source: string; readonly target: string }> {
  const { source, target, remoteSource, remoteTarget, size, mode, sourceRevision, targetRevision } =
    await prepareTransfer(registry, input, context, captured);
  await verifyApprovedEntries?.();
  const descriptor = remoteSource
    ? undefined
    : await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporary: string | undefined;
  let destination: FileHandle | undefined;
  let channel: SshProcessChannel | undefined;
  let started = false;
  let committing = false;
  let published = false;
  let written = 0;
  let output = "";
  // A transfer may take minutes, so only a pause while bytes should move ends it.
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), TRANSFER_STALL_MS);
  };
  const signal = context.signal ? AbortSignal.any([context.signal, stall.signal]) : stall.signal;
  const throwIfStopped = () => {
    context.signal?.throwIfAborted();
    if (stall.signal.aborted) throw new SshBackendError("TRANSFER_STALLED", source, "not-applied");
  };
  const verifySource = async () => {
    const current = remoteSource
      ? await remoteSource.backend.lstat(remoteSource.location.path, context)
      : await localEntry(source);
    const revision = "revision" in current ? current.revision : localRevision(current);
    if (revision !== sourceRevision) throw new SshBackendError("CONFLICT", source, "not-applied");
  };
  const digest = createHash("sha256");
  // The write the target has not acknowledged yet. Each chunk waits only for the one before it,
  // so the next chunk is already on the link while the target acknowledges the previous one.
  let pending: Promise<void> | undefined;
  const settle = async () => {
    const previous = pending;
    pending = undefined;
    await previous;
  };
  const deliver = async (bytes: Buffer) => {
    throwIfStopped();
    digest.update(bytes);
    if (channel) {
      const accepted = channel.write(bytes).then(() => {
        written += bytes.length;
        progress();
      });
      void accepted.catch(() => {});
      const previous = pending;
      pending = accepted;
      await previous;
      return;
    }
    if (destination === undefined) throw new Error("Missing destination descriptor");
    for (let offset = 0; offset < bytes.length;) {
      const result = await destination.write(bytes, offset, bytes.length - offset);
      if (result.bytesWritten === 0)
        throw new SshBackendError("TRANSFER_FAILED", target, "not-applied");
      offset += result.bytesWritten;
    }
    written += bytes.length;
    progress();
  };
  try {
    if (descriptor && localRevision(await descriptor.stat({ bigint: true })) !== sourceRevision)
      throw new SshBackendError("CONFLICT", source, "not-applied");
    started = true;
    progress();
    if (remoteTarget) {
      channel = await startSshProcess(
        remoteTarget.backend.target,
        remotePython(await sshTransferProgram(targetOs(remoteTarget.backend.target))),
        [
          JSON.stringify({
            destination: remoteTarget.location.path,
            size,
            mode,
            expected: targetRevision,
          }),
        ],
        neutralDirectory(remoteTarget.backend.target),
        // The receiver removes its staging file when its input ends before the commit request.
        { ...context, signal, gracefulStop: true },
      );
      channel.completion.catch(() => {});
      channel.stdout.on("data", (chunk: Buffer) => {
        if (output.length <= 8192) output += chunk.toString("utf8");
        if (output.length > 8192) void channel?.stop().catch(() => {});
      });
      channel.stderr.resume();
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      temporary = path.join(
        path.dirname(target),
        `.pi-ide-transfer-${randomBytes(12).toString("hex")}`,
      );
      destination = await open(temporary, "wx", mode & 0o7777);
    }
    // Each channel startup has its own deadline, so the stall window restarts once a step completes.
    progress();
    if (remoteSource) {
      // One channel streams the whole file; the target rechecks its revision after the last byte.
      const sent = await remoteSource.backend.readStream(
        remoteSource.location.path,
        sourceRevision,
        deliver,
        { ...context, signal },
      );
      await settle();
      if (sent.totalBytes !== size || written !== size)
        throw new SshBackendError("CONFLICT", source, "not-applied");
      if (sent.sha256 !== digest.copy().digest("hex"))
        throw new SshBackendError("CHECKSUM_MISMATCH", source, "not-applied");
    } else {
      if (descriptor === undefined) throw new Error("Missing source descriptor");
      for (let offset = 0; offset < size;) {
        const limit = Math.min(CHUNK_BYTES, size - offset);
        const buffer = Buffer.allocUnsafe(limit);
        const { bytesRead } = await descriptor.read(buffer, 0, limit, offset);
        if (bytesRead === 0) throw new SshBackendError("CONFLICT", source, "not-applied");
        await deliver(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      await settle();
    }
    // Verification requests have their own deadlines and move no bytes, so they never count as a stall.
    clearTimeout(stallTimer);
    await verifySource();
    // Keep an object transfer tied to its approved leaf versions, not a newer staged snapshot.
    await verifyApprovedEntries?.();
    const sha256 = digest.digest("hex");
    throwIfStopped();
    if (channel) {
      // From the commit request on, the target may publish before its reply arrives.
      committing = true;
      // The target hashes and publishes after the commit request; a dead link must still end the wait.
      progress();
      await channel.write(Buffer.from(`${JSON.stringify({ sha256 })}\n`));
      await channel.end();
      const completion = await channel.completion;
      if (completion.exitCode !== 0 || output.length > 8192)
        throw new SshBackendError("TRANSFER_FAILED", target, "unknown");
      let reply: unknown;
      try {
        reply = JSON.parse(output);
      } catch {
        throw new SshBackendError("INVALID_REPLY", target, "unknown");
      }
      if (reply === null || typeof reply !== "object" || !("ok" in reply))
        throw new SshBackendError("INVALID_REPLY", target, "unknown");
      if (reply.ok !== true) {
        const effect =
          "effect" in reply && (reply.effect === "not-applied" || reply.effect === "applied")
            ? reply.effect
            : "unknown";
        throw new SshBackendError(errorCode(reply), target, effect);
      }
      if (!("sha256" in reply) || reply.sha256 !== sha256)
        throw new SshBackendError("CHECKSUM_MISMATCH", target, "unknown");
      published = true;
    } else {
      if (destination === undefined || temporary === undefined)
        throw new Error("Missing staged destination");
      await destination.chmod(mode & 0o7777);
      await destination.sync();
      await destination.close();
      destination = undefined;
      let currentRevision: string | null = null;
      try {
        currentRevision = localRevision(await localEntry(target));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (currentRevision !== targetRevision)
        throw new SshBackendError("CONFLICT", target, "not-applied");
      context.signal?.throwIfAborted();
      await rename(temporary, target);
      temporary = undefined;
      published = true;
    }
    clearTimeout(stallTimer);
    if (operation === "move") {
      await verifySource();
      if (remoteSource)
        await remoteSource.backend.removeEntry(remoteSource.location.path, sourceRevision, context);
      else await unlink(source);
    }
    return { source, target };
  } catch (error) {
    if (published) throw new SshBackendError(errorCode(error), source, "unknown");
    if (!started) throw error;
    const code = context.signal?.aborted
      ? "CANCELLED"
      : stall.signal.aborted
        ? "TRANSFER_STALLED"
        : errorCode(error);
    // Bytes are staged until the commit request, so an earlier failure leaves the destination as it was.
    const effect = committing
      ? error instanceof SshBackendError
        ? error.effect
        : "unknown"
      : "not-applied";
    throw new SshTransferError(
      code,
      source,
      target,
      effect,
      written,
      size,
      error instanceof SshBackendError ? { cause: error } : undefined,
    );
  } finally {
    clearTimeout(stallTimer);
    await descriptor?.close();
    await destination?.close();
    if (temporary !== undefined) await rm(temporary, { force: true });
    if (channel) await channel.stop().catch(() => {});
  }
}
