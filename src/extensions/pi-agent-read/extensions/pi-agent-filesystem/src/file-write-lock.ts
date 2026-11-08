import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A lock older than this belongs to a process that died while holding it. */
const STALE_LOCK_MS = 10_000;
const WAIT_TIMEOUT_MS = 30_000;

/**
 * Runs `action` while no other Pi process on this machine reads or writes the same file through
 * Pi Agent IDE. The lock is a directory in the temporary folder, so it leaves nothing in the
 * project. When that folder is not writable, `action` runs without the lock, as it would
 * without this guard.
 */
export async function withFileWriteLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const directory = path.join(
    os.tmpdir(),
    `pi-agent-ide-write-locks${process.getuid ? `-${String(process.getuid())}` : ""}`,
  );
  const lock = path.join(
    directory,
    createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 32),
  );
  if (!(await acquire(directory, lock, filePath, signal))) return action();
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Waits for the lock; false when the lock folder cannot be created. */
async function acquire(
  directory: string,
  lock: string,
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return false;
  }
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    const changed = await stat(lock).then(
      (stats) => stats.mtimeMs,
      () => undefined,
    );
    if (changed !== undefined && Date.now() - changed > STALE_LOCK_MS) {
      await rm(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > WAIT_TIMEOUT_MS)
      throw new Error(`Timed out waiting for another Pi process to finish with ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  }
}
