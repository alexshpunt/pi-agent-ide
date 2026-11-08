import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A lock older than this belongs to a process that died while writing. */
const STALE_LOCK_MS = 10_000;
const WAIT_TIMEOUT_MS = 30_000;

/**
 * Runs `write` while no other Pi process on this machine writes the same file through Pi Agent
 * IDE. The lock is a directory in the temporary folder, so it leaves nothing in the project.
 */
export async function withFileWriteLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  write: () => Promise<T>,
): Promise<T> {
  const directory = path.join(
    os.tmpdir(),
    `pi-agent-ide-write-locks${process.getuid ? `-${String(process.getuid())}` : ""}`,
  );
  await mkdir(directory, { recursive: true });
  const lock = path.join(
    directory,
    createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 32),
  );
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
      throw new Error(`Timed out waiting for another Pi process to finish writing ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  }
  try {
    return await write();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
