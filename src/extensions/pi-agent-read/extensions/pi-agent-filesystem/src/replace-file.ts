import { randomBytes } from "node:crypto";
import { chmod, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Replaces a file's content so that other programs reading it, such as ripgrep or a language
 * server, see either the old or the new text, never a partly written file. The text is written to
 * a temporary file next to the target, which then replaces the target in one rename. A symlink is
 * followed, so the link stays and its target changes.
 *
 * A rename would give the file a new identity. When that would change what the file is, the
 * content is written in place instead: for a file with other hard links, a file owned by another
 * user, or a rename the system refuses, such as for a file another program holds open on Windows.
 */
export async function replaceFileContent(
  filePath: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  const writeInPlace = () => writeFile(filePath, bytes, signal === undefined ? {} : { signal });
  const target = await realpath(filePath).catch(() => undefined);
  const existing = target === undefined ? undefined : await stat(target).catch(() => undefined);
  if (target === undefined || existing === undefined) return writeInPlace();
  const ownedByAnother = process.getuid !== undefined && existing.uid !== process.getuid();
  if (!existing.isFile() || existing.nlink > 1 || ownedByAnother) return writeInPlace();

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.pi-tmp`,
  );
  try {
    const mode = existing.mode & 0o7777;
    await writeFile(temporary, bytes, {
      mode,
      flag: "wx",
      ...(signal !== undefined && { signal }),
    });
    // The process umask narrows the mode a file is created with; the replacement keeps the original.
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    signal?.throwIfAborted();
    // A file that cannot be replaced still gets its new content, as before.
    if (isRenameRefusal(error)) return writeInPlace();
    throw error;
  }
}

function isRenameRefusal(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EXDEV";
}
