import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Record the actual current IDE source, including shared uncommitted work; a commit alone is not a clean-source claim. */
export async function captureIdeSource(root = "/root/dev/pi/pi-agent-ide") {
  const git = async (...args) =>
    (await execute("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const commit = (await git("rev-parse", "HEAD")).trim();
  assert.equal(
    commit,
    (await git("rev-parse", "origin/develop")).trim(),
    "IDE is not at the fetched develop commit",
  );
  const manifest = {};
  for (const file of (
    await git("ls-files", "-z", "src", "packages", "package.json", "pnpm-lock.yaml")
  )
    .split("\0")
    .filter(Boolean)
    .sort()) {
    if (/\.(?:test|spec)\./.test(file)) continue;
    manifest[file] = createHash("sha256")
      .update(await readFile(path.join(root, file)))
      .digest("hex");
  }
  const sourceDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const status = await git("status", "--short");
  return {
    source: root,
    version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
    commit,
    sourceDirty: status.length > 0,
    status,
    sourceDigest,
    manifest,
  };
}
