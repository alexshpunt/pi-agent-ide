import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { ApplyFileBackup, ApplyFileState } from "#src/api/apply-files.js";
import { isUriSource } from "#src/core/file-operations.js";

interface LocalBackup {
  readonly file: string;
  readonly source: string;
  readonly revision: string;
  readonly metadata: BigIntStats;
}
const chunkBytes = 1024 * 1024;

function revision(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}
function failure(code: string, message: string, effect = "not-applied"): Error {
  return Object.assign(new Error(message), { code, effect });
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
/** Filesystem acknowledgement boundary used by a local journal owner. */
export interface LocalJournalIO {
  readonly lstat: (file: string, options: { bigint: true }) => Promise<BigIntStats>;
  readonly rename: (source: string, target: string) => Promise<void>;
}

/** Create an isolated local journal owner with its own revision observations. */
export function createLocalFileJournal(io: LocalJournalIO = { lstat, rename }) {
  const backups = new WeakMap<ApplyFileBackup, LocalBackup>();
  const observed = new Map<string, string | null>();
  const { lstat, rename } = io;
  async function fileStat(file: string): Promise<BigIntStats | undefined> {
    try {
      const stat = await lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink())
        throw failure("INVALID_FILE_TYPE", `${file} is not a regular file.`);
      return stat;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }
  async function unlinkMissing(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  async function openSource(file: string): Promise<FileHandle> {
    return open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  async function copyBytes(
    source: FileHandle,
    target: FileHandle,
    signal?: AbortSignal,
  ): Promise<string> {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const hash = createHash("sha256");
    let position = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0)
          throw failure("WRITE_FAILED", "Snapshot write made no progress.");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await target.truncate(position);
    return hash.digest("hex");
  }
  async function metadata(target: FileHandle, stat: BigIntStats): Promise<void> {
    const current = await target.stat({ bigint: true });
    if (current.uid !== stat.uid || current.gid !== stat.gid)
      await target.chown(Number(stat.uid), Number(stat.gid));
    await target.chmod(Number(stat.mode & 0o7777n));
    await target.utimes(Number(stat.atimeNs) / 1e9, Number(stat.mtimeNs) / 1e9);
  }

  /** Capture a regular local file in a private disk journal using bounded byte buffers. */
  async function captureLocalFileState(
    source: string,
    signal?: AbortSignal,
  ): Promise<ApplyFileState> {
    signal?.throwIfAborted();
    if (isUriSource(source))
      throw failure("UNSUPPORTED_SOURCE", "No local snapshot owner for this URI.");
    const file = path.resolve(source);
    const initial = await fileStat(file);
    if (initial === undefined) {
      observed.set(file, null);
      return { path: file, existed: false };
    }
    const container = path.resolve(".tmp/apply-journals");
    await mkdir(container, { recursive: true, mode: 0o700 });
    const containerStat = await lstat(container, { bigint: true });
    if (!containerStat.isDirectory() || containerStat.isSymbolicLink())
      throw failure("INVALID_SNAPSHOT", "Snapshot storage is not a directory.");
    const directory = await mkdtemp(path.join(container, "snapshot-"));
    const snapshot = path.join(directory, "bytes");
    let input: FileHandle | undefined;
    let output: FileHandle | undefined;
    let kept = false;
    try {
      input = await openSource(file);
      const original = await input.stat({ bigint: true });
      if (!original.isFile() || revision(original) !== revision(initial))
        throw failure("CONFLICT", `${file} changed before capture.`);
      output = await open(snapshot, "wx", 0o600);
      const sha256 = await copyBytes(input, output, signal);
      signal?.throwIfAborted();
      if (
        revision(await input.stat({ bigint: true })) !== revision(initial) ||
        revision(await lstat(file, { bigint: true })) !== revision(initial)
      )
        throw failure("CONFLICT", `${file} changed during capture.`);
      await output.sync();
      const snapshotRevision = revision(await output.stat({ bigint: true }));
      let releasing: Promise<void> | undefined;
      const backup: ApplyFileBackup = {
        sha256,
        release() {
          releasing ??= (async () => {
            try {
              await unlink(snapshot);
            } catch (error) {
              if (!hasCode(error, "ENOENT")) throw error;
            }
            try {
              await rmdir(directory);
            } catch (error) {
              if (!hasCode(error, "ENOENT")) throw error;
            }
          })().catch((error: unknown) => {
            releasing = undefined;
            throw error;
          });
          return releasing;
        },
      };
      backups.set(backup, {
        file: snapshot,
        source: file,
        revision: snapshotRevision,
        metadata: original,
      });
      observed.set(file, revision(initial));
      kept = true;
      return { path: file, existed: true, backup };
    } finally {
      await input?.close();
      await output?.close();
      if (!kept) {
        await unlinkMissing(snapshot);
        await rmdir(directory);
      }
    }
  }

  /** Record a completed local operation before later post-processing or compensation. */
  async function observeLocalFileState(file: string): Promise<void> {
    const current = await fileStat(file);
    observed.set(path.resolve(file), current === undefined ? null : revision(current));
  }
  /** Restore through the local owner, refusing changes visible at the final revision check. */
  async function restoreLocalFileState(state: ApplyFileState, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (isUriSource(state.path))
      throw failure("UNSUPPORTED_SOURCE", "No local snapshot owner for this URI.");
    const file = path.resolve(state.path);
    const expected = observed.get(file);
    const check = async () => {
      const stat = await fileStat(file);
      if (expected === undefined || (stat === undefined ? null : revision(stat)) !== expected)
        throw failure("CONFLICT", `${file} changed before restoration.`);
      return stat;
    };
    let published = false;
    try {
      if (state.backup === undefined) {
        // Inline states are used by callers supplying their own small snapshot.
        if (expected !== undefined) await check();
        if (!state.existed) {
          try {
            await unlink(file);
            published = true;
          } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
          }
        } else {
          await mkdir(path.dirname(file), { recursive: true });
          signal?.throwIfAborted();
          published = true;
          await writeFile(file, state.bytes ?? new Uint8Array());
        }
      } else {
        const backup = backups.get(state.backup);
        if (backup === undefined || backup.source !== file)
          throw failure("INVALID_SNAPSHOT", "Snapshot belongs to another file owner.");
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(
          path.dirname(file),
          `.pi-ide-undo-${randomBytes(8).toString("hex")}`,
        );
        let input: FileHandle | undefined;
        let output: FileHandle | undefined;
        try {
          input = await openSource(backup.file);
          if (revision(await input.stat({ bigint: true })) !== backup.revision)
            throw failure("INVALID_SNAPSHOT", "Snapshot changed before restoration.");
          output = await open(temporary, "wx", 0o600);
          const digest = await copyBytes(input, output, signal);
          if (
            digest !== state.backup.sha256 ||
            revision(await input.stat({ bigint: true })) !== backup.revision
          )
            throw failure("INVALID_SNAPSHOT", "Snapshot changed during restoration.");
          await metadata(output, backup.metadata);
          await output.sync();
          const current = await check();
          signal?.throwIfAborted();
          await output.close();
          output = undefined;
          if (current !== undefined && current.nlink > 1n) {
            // Replacing a linked entry would leave its aliases with stale bytes.
            // In-place restoration is not atomic; interruption has an unknown effect.
            const staged = await openSource(temporary);
            let linked: FileHandle | undefined;
            try {
              linked = await open(
                file,
                constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
              if (revision(await linked.stat({ bigint: true })) !== expected)
                throw failure("CONFLICT", `${file} changed before restoration.`);
              await check();
              signal?.throwIfAborted();
              published = true;
              await copyBytes(staged, linked, signal);
              await metadata(linked, backup.metadata);
              await linked.sync();
            } finally {
              await staged.close();
              await linked?.close();
            }
          } else {
            await rename(temporary, file);
            published = true;
          }
        } finally {
          await input?.close();
          await output?.close();
          await unlinkMissing(temporary);
        }
      }
      const final = await fileStat(file);
      observed.set(file, final === undefined ? null : revision(final));
    } catch (error) {
      if (published)
        throw failure(
          "RESTORE_FAILED",
          "Restoration may have completed but its acknowledgement failed.",
          "unknown",
        );
      throw error;
    }
  }

  return {
    capture: captureLocalFileState,
    restore: restoreLocalFileState,
    observe: observeLocalFileState,
  };
}

const localJournal = createLocalFileJournal();
/** Capture a regular local file in a bounded disk journal. */
export const captureLocalFileState = localJournal.capture;
/** Restore a local snapshot with final revision checks. */
export const restoreLocalFileState = localJournal.restore;
/** Observe a completed local operation before compensation. */
export const observeLocalFileState = localJournal.observe;
