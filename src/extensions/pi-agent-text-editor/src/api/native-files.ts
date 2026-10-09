import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { Stats } from "node:fs";
import type { FileObjectEntry, FileObjectSnapshot, FileTransferAccess } from "./file-transfers.js";

const exec = promisify(execFile);

function kind(stat: Stats): FileObjectEntry["kind"] {
  return stat.isSymbolicLink()
    ? "symlink"
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : "other";
}
function revision(stat: Stats): string {
  return JSON.stringify([
    stat.dev,
    stat.ino,
    stat.birthtimeMs,
    stat.ctimeMs,
    stat.mtimeMs,
    stat.size,
    stat.mode,
  ]);
}
async function optionalStat(source: string) {
  return lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
async function resolveParent(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (await optionalStat(directory)))
      throw error;
    return path.join(await resolveParent(path.dirname(directory)), path.basename(directory));
  }
}

/** Capture native local objects without dereferencing links, including missing transfer destinations. */
export async function snapshotLocalObjects(
  source: string,
  signal?: AbortSignal,
): Promise<FileObjectSnapshot> {
  const resolved = path.join(await resolveParent(path.dirname(source)), path.basename(source));
  const entries: FileObjectEntry[] = [];
  const walk = async (file: string, relativePath: string): Promise<void> => {
    signal?.throwIfAborted();
    const stat = await optionalStat(file);
    if (stat === undefined) {
      if (relativePath !== "")
        throw Object.assign(new Error("Transfer entry disappeared"), {
          code: "TRANSFER_TARGET_CHANGED",
        });
      return;
    }
    const entry: FileObjectEntry = {
      relativePath,
      kind: kind(stat),
      revision: revision(stat),
      identity: { device: String(stat.dev), inode: String(stat.ino) },
      mode: stat.mode,
      ...(stat.isSymbolicLink()
        ? { link: (await readlink(file, { encoding: "buffer" })).toString("base64") }
        : {}),
    };
    entries.push(entry);
    if (entry.kind === "directory") {
      for (const name of (await readdir(file)).sort())
        await walk(path.join(file, name), relativePath === "" ? name : `${relativePath}/${name}`);
      const current = await optionalStat(file);
      if (current === undefined || revision(current) !== entry.revision)
        throw Object.assign(new Error("Transfer directory changed while inspecting its children"), {
          code: "TRANSFER_TARGET_CHANGED",
        });
    }
  };
  await walk(resolved, "");
  return { path: resolved, entries };
}

/** Built-in local owner for shared local/SSH object policy; no controller path fallback for remote owners. */
export const localFileTransferAccess: FileTransferAccess = {
  owner: "local",
  async temporaryEnvironment(signal) {
    signal?.throwIfAborted();
    const agent = process.env.PI_CODING_AGENT_DIR?.trim();
    return {
      home: os.homedir(),
      temporary: os.tmpdir(),
      ...(agent ? { agentDirectory: path.resolve(agent) } : {}),
    };
  },
  pathStyle: "native",
  realpath,
  async inspect(source) {
    const stat = await lstat(source);
    return {
      kind: kind(stat),
      revision: revision(stat),
      identity: { device: String(stat.dev), inode: String(stat.ino) },
      mode: stat.mode,
    };
  },
  read: (source) => readFile(source, "utf8"),
  async git(cwd, args, signal) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      signal,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  },
  source: (source) => source,
  snapshot: snapshotLocalObjects,
};
