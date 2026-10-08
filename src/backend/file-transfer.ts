import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileOperationInput } from "pi-agent-text-editor/api/plugin-protocol";
import type { ResourceResolverContext } from "pi-agent-resource";
import type { SshBackendRegistry } from "./registry.js";
import { SshBackendError } from "./ssh.js";
import { checkCapturedRevision } from "./file-revision.js";
import { startSshProcess, type SshProcessChannel } from "./ssh-channel.js";

const CHUNK_BYTES = 1024 * 1024;
const worker = readFile(new URL("./ssh-transfer-worker.py", import.meta.url), "utf8");

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
  const mode = Number(sourceInfo.mode);
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
 */
export async function transferFile(
  registry: SshBackendRegistry,
  operation: "copy" | "move",
  input: FileOperationInput,
  context: ResourceResolverContext,
  captured?: ReadonlyMap<string, string | null>,
): Promise<{ readonly source: string; readonly target: string }> {
  const { source, target, remoteSource, remoteTarget, size, mode, sourceRevision, targetRevision } =
    await prepareTransfer(registry, input, context, captured);
  const descriptor = remoteSource
    ? undefined
    : await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporary: string | undefined;
  let destination;
  let channel: SshProcessChannel | undefined;
  let published = false;
  let output = "";
  const verifySource = async () => {
    const current = remoteSource
      ? await remoteSource.backend.lstat(remoteSource.location.path, context)
      : await localEntry(source);
    const revision = "revision" in current ? current.revision : localRevision(current);
    if (revision !== sourceRevision) throw new SshBackendError("CONFLICT", source, "not-applied");
  };
  try {
    if (descriptor && localRevision(await descriptor.stat({ bigint: true })) !== sourceRevision)
      throw new SshBackendError("CONFLICT", source, "not-applied");
    if (remoteTarget) {
      channel = await startSshProcess(
        remoteTarget.backend.target,
        "python3",
        [
          "-c",
          await worker,
          JSON.stringify({
            destination: remoteTarget.location.path,
            size,
            mode,
            expected: targetRevision,
          }),
        ],
        "/",
        context,
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
    const digest = createHash("sha256");
    for (let offset = 0; offset < size;) {
      context.signal?.throwIfAborted();
      const limit = Math.min(CHUNK_BYTES, size - offset);
      let bytes: Buffer;
      if (remoteSource) {
        const range = await remoteSource.backend.readRange(
          remoteSource.location.path,
          offset,
          limit,
          context,
        );
        if (
          range.revision !== sourceRevision ||
          range.offset !== offset ||
          range.totalBytes !== size
        )
          throw new SshBackendError("CONFLICT", source, "not-applied");
        bytes = range.bytes;
      } else {
        if (descriptor === undefined) throw new Error("Missing source descriptor");
        const buffer = Buffer.allocUnsafe(limit);
        const { bytesRead } = await descriptor.read(buffer, 0, limit, offset);
        bytes = buffer.subarray(0, bytesRead);
      }
      if (bytes.length === 0) throw new SshBackendError("CONFLICT", source, "not-applied");
      digest.update(bytes);
      if (channel) await channel.write(bytes);
      else {
        if (destination === undefined) throw new Error("Missing destination descriptor");
        for (let written = 0; written < bytes.length;) {
          const result = await destination.write(bytes, written, bytes.length - written);
          if (result.bytesWritten === 0)
            throw new SshBackendError("TRANSFER_FAILED", target, "not-applied");
          written += result.bytesWritten;
        }
      }
      offset += bytes.length;
    }
    await verifySource();
    const sha256 = digest.digest("hex");
    context.signal?.throwIfAborted();
    if (channel) {
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
    if (operation === "move") {
      await verifySource();
      if (remoteSource)
        await remoteSource.backend.removeEntry(remoteSource.location.path, sourceRevision, context);
      else await unlink(source);
    }
    return { source, target };
  } catch (error) {
    if (published) throw new SshBackendError(errorCode(error), source, "unknown");
    throw error;
  } finally {
    await descriptor?.close();
    await destination?.close();
    if (temporary !== undefined) await rm(temporary, { force: true });
    if (channel) await channel.stop().catch(() => {});
  }
}
