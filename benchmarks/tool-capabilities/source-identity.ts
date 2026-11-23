import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Hash current tracked and unignored source bytes, in path order and without duplicates. */
export async function sourceIdentity(
  repository: string,
  options: {
    include?: (file: string) => boolean;
    visit?: (file: string, bytes: Buffer | undefined) => Promise<void>;
  } = {},
): Promise<{ revision: string; sourceDigest: string }> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  const revision = git(["rev-parse", "HEAD"]).trim();
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0");
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    if (!file || options.include?.(file) === false) continue;
    const bytes = await readFile(path.join(repository, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      },
    );
    if (bytes) hash.update(file).update("\0").update(bytes).update("\0");
    // Let a snapshot use exactly the hashed bytes and remove deleted paths from its clone.
    await options.visit?.(file, bytes);
  }
  return { revision, sourceDigest: hash.digest("hex") };
}
