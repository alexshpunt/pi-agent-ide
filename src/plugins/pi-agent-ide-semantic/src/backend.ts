import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const VERSION = "1.8.5";
const RELEASE = `https://github.com/lightonai/next-plaid/releases/download/v${VERSION}`;
const ASSETS: Record<string, { name: string; sha256: string }> = {
  "linux:x64": {
    name: "colgrep-x86_64-unknown-linux-gnu.tar.xz",
    sha256: "532e1da739f6b5d489cdaefd20c5918fa1bb0ff9f456c89098eb49a6379ae205",
  },
  "linux:arm64": {
    name: "colgrep-aarch64-unknown-linux-gnu.tar.xz",
    sha256: "90ccb4132ca34c5202ca3d9789e722446dfed85b3be6247321ee55e1a909f34b",
  },
  "darwin:x64": {
    name: "colgrep-x86_64-apple-darwin.tar.xz",
    sha256: "6f23777e87a7cee9c31846514bc0a70736df71f201abfff6aedb51dc27ec6c2a",
  },
  "darwin:arm64": {
    name: "colgrep-aarch64-apple-darwin.tar.xz",
    sha256: "2cd013c820a6ba9d4066c58ce7e6b75ea614dd77a9a18a88836e005f1ef126bc",
  },
  "win32:x64": {
    name: "colgrep-x86_64-pc-windows-msvc.zip",
    sha256: "4f8f240ccbf17740e70d36b798904cf592622719bf11e9c1c86dc01cf9f2c42d",
  },
};

export interface BackendOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
}

export interface ProjectStatus {
  readonly usable: boolean;
  readonly executable?: string;
  readonly indexPath?: string;
}

function localProject(cwd: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(cwd))
    throw new Error("Semantic search supports local projects only");
  return resolve(cwd);
}

function managedDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return process.platform === "win32"
    ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pi-agent-ide", "bin")
    : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "pi-agent-ide", "bin");
}

function binaryName(): string {
  return process.platform === "win32" ? "colgrep.exe" : "colgrep";
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: BackendOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: options.env ?? process.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-4_000_000);
      options.onProgress?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
      options.onProgress?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveRun(stdout)
        : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)),
    );
  });
}

/** Find a working user-installed or IDE-managed ColGREP without downloading anything. */
export async function findColgrep(options: BackendOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const candidates = [
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binaryName())),
    join(managedDirectory(env), binaryName()),
    join(
      env.CARGO_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".cargo"),
      "bin",
      binaryName(),
    ),
  ];
  for (const candidate of new Set(candidates)) {
    options.signal?.throwIfAborted();
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const version = await run(candidate, ["--version"], process.cwd(), {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
        onProgress: undefined,
      });
      if (/^colgrep\s+\d+\.\d+\.\d+/u.test(version)) return candidate;
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  return undefined;
}

/** Detect the index used by ColGREP, including an existing indexed parent project. */
export async function inspectProject(
  cwd: string,
  options: BackendOptions = {},
): Promise<ProjectStatus> {
  const project = localProject(cwd);
  const executable = await findColgrep(options);
  if (!executable) return { usable: false };
  try {
    const status = await run(executable, ["status", "--color", "never"], project, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
      onProgress: undefined,
    });
    const indexPath = /^Index:\s+(.+)\s*$/mu.exec(status)?.[1]?.trim();
    if (!indexPath || !(await stat(indexPath)).isDirectory()) return { usable: false, executable };
    return { usable: true, executable, indexPath };
  } catch {
    options.signal?.throwIfAborted();
    return { usable: false, executable };
  }
}

/** Install the pinned, checksum-verified executable in a shared per-user location. */
async function installColgrep(options: BackendOptions): Promise<string> {
  const asset = ASSETS[`${process.platform}:${process.arch}`];
  if (!asset)
    throw new Error(
      `No ColGREP binary for ${process.platform}/${process.arch}; install colgrep yourself`,
    );
  options.onProgress?.(`Downloading ColGREP ${VERSION}\n`);
  const response = await fetch(`${RELEASE}/${asset.name}`, { signal: options.signal });
  if (!response.ok) throw new Error(`ColGREP download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("ColGREP download checksum mismatch");
  const temp = await mkdtemp(join(tmpdir(), "pi-colgrep-"));
  try {
    const archive = join(temp, asset.name);
    await writeFile(archive, bytes);
    await run("tar", ["-xf", archive, "-C", temp], temp, { ...options, onProgress: undefined });
    const folder = asset.name.replace(/\.(?:tar\.xz|zip)$/u, "");
    const source = join(temp, folder, binaryName());
    const targetDir = managedDirectory(options.env ?? process.env);
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, binaryName());
    const staging = await mkdtemp(join(targetDir, ".install-"));
    try {
      const staged = join(staging, binaryName());
      await copyFile(source, staged, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") await chmod(staged, 0o755);
      try {
        await link(staged, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Another explicit setup may have completed concurrently; never overwrite it.
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await run(target, ["--version"], temp, { ...options, onProgress: undefined });
    return target;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Explicit opt-in: install only if needed, then create or incrementally update this index. */
export async function indexProject(
  cwd: string,
  options: BackendOptions = {},
): Promise<ProjectStatus> {
  const project = localProject(cwd);
  const executable = (await findColgrep(options)) ?? (await installColgrep(options));
  options.onProgress?.("Indexing project with ColGREP\n");
  await run(executable, ["init", "--yes", "--color", "never"], project, options);
  const status = await inspectProject(project, options);
  if (!status.usable) throw new Error("ColGREP did not create a usable project index");
  return status;
}

/** Search an existing index; ColGREP incrementally refreshes it before every query. */
export async function searchProject(
  cwd: string,
  query: string,
  options: BackendOptions & { readonly limit?: number } = {},
): Promise<string> {
  const project = localProject(cwd);
  if (!query.trim()) throw new Error("A semantic search query is required");
  const status = await inspectProject(project, options);
  if (!status.usable || !status.executable)
    throw new Error("No usable semantic index for this project");
  const limit = options.limit ?? 15;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid result limit");
  const output = await run(
    status.executable,
    ["search", "--json", "--yes", "--color", "never", "-k", String(limit), "--", query],
    project,
    options,
  );
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Invalid ColGREP search output");
  return output;
}
