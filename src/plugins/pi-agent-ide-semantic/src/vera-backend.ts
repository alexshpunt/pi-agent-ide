import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { searchFiles } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/file-search.js";
import type { BackendOptions, ProjectStatus } from "./backend.js";

const VERSION = "2.3.0"; // Version with the verified JSON and filtering contracts.
const RELEASE = `https://github.com/VeraTools/vera/releases/download/v${VERSION}`;
const MODEL =
  "models/minishlab/potion-code-16M-v2/revisions/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b";
const ASSETS: Record<string, { name: string; sha256: string }> = {
  "linux:x64": {
    name: "vera-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "cf0e4c7847eaf2b4dd95c02c623ade21532762d1cf2a9361ea91558ba42145f9",
  },
  "linux:arm64": {
    name: "vera-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "ff60f0f1c2796e7c249bf72ebc0212ca7f362f0f3d951d026ac522ea27e4eed3",
  },
  "darwin:x64": {
    name: "vera-x86_64-apple-darwin.tar.gz",
    sha256: "4864b2214df81d1d30cd0fd27adb41d98bb159d37be63f839f84627300858836",
  },
  "darwin:arm64": {
    name: "vera-aarch64-apple-darwin.tar.gz",
    sha256: "62d857a3085e5560377977893c3b3ef74c8be5f042b2b16b0c79d9a83651c3b8",
  },
  "win32:x64": {
    name: "vera-x86_64-pc-windows-msvc.zip",
    sha256: "9567d4ce722d8b941c7b5b13e8a99c448875a1914216291e691611870f2fd2b6",
  },
};

function projectPath(cwd: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(cwd))
    throw new Error("Semantic search supports local projects only");
  return resolve(cwd);
}

function managedRoot(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return process.platform === "win32"
    ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pi-agent-ide")
    : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "pi-agent-ide");
}

function veraEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never inherit Vera's external endpoint, model or reranker settings. The IDE
  // owns this data directory so the user's Vera configuration stays unchanged.
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/^(?:VERA_|EMBEDDING_|RERANKER_|LOCAL_RERANKER_)/iu.test(key),
    ),
  );
  return {
    ...clean,
    VERA_HOME: join(managedRoot(env), "vera"),
    VERA_BACKEND: "potion-code-cpu",
    VERA_NO_UPDATE_CHECK: "1",
  };
}

function binaryName(): string {
  return process.platform === "win32" ? "vera.exe" : "vera";
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: BackendOptions,
  env = veraEnvironment(options.env ?? process.env),
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) {
        overflow = true;
        child.kill();
      }
      options.onProgress?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
      options.onProgress?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      overflow
        ? reject(new Error("Vera output exceeded the size limit"))
        : code === 0
          ? done(stdout)
          : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)),
    );
  });
}

async function findVera(options: BackendOptions): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const candidates = [
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binaryName())),
    join(managedRoot(env), "bin", binaryName()),
  ];
  for (const candidate of new Set(candidates)) {
    options.signal?.throwIfAborted();
    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const version = await run(candidate, ["--version"], process.cwd(), {
        ...options,
        onProgress: undefined,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      if (version.trim() === `vera ${VERSION}`) return candidate;
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  return undefined;
}

async function modelReady(options: BackendOptions): Promise<boolean> {
  const dir = join(veraEnvironment(options.env ?? process.env).VERA_HOME as string, MODEL);
  try {
    for (const file of ["config.json", "tokenizer.json", "model.safetensors"])
      await access(join(dir, file), constants.R_OK);
    return true;
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}

async function indexValid(
  executable: string,
  project: string,
  options: BackendOptions,
): Promise<boolean> {
  try {
    if (!(await lstat(join(project, ".vera"))).isDirectory()) return false;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000);
    const result: unknown = JSON.parse(
      await run(executable, ["stats", "--json"], project, {
        ...options,
        onProgress: undefined,
        signal,
      }),
    );
    return (
      typeof result === "object" &&
      result !== null &&
      "file_count" in result &&
      typeof result.file_count === "number" &&
      "chunk_count" in result &&
      typeof result.chunk_count === "number"
    );
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}

async function requireLocalConfiguration(options: BackendOptions): Promise<void> {
  const home = veraEnvironment(options.env ?? process.env).VERA_HOME as string;
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  } catch {
    throw new Error("Vera local configuration is missing or invalid; run /semantic-index");
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !("backend" in config) ||
    config.backend !== "potion-code" ||
    !("local_mode" in config) ||
    config.local_mode !== true ||
    Object.keys(config).some((key) => !["config_format", "local_mode", "backend"].includes(key))
  )
    throw new Error("Vera local configuration contains unsupported settings; refusing to search");
}

/** Inspect only the current project's index and the IDE-managed local model. */
export async function inspectVeraProject(
  cwd: string,
  options: BackendOptions = {},
): Promise<ProjectStatus> {
  const project = projectPath(cwd);
  const executable = await findVera(options);
  if (!executable) return { usable: false };
  try {
    await requireLocalConfiguration(options);
  } catch {
    options.signal?.throwIfAborted();
    return { usable: false, executable };
  }
  if (!(await modelReady(options)) || !(await indexValid(executable, project, options)))
    return { usable: false, executable };
  return { usable: true, executable, indexPath: join(project, ".vera") };
}

async function installVera(options: BackendOptions): Promise<string> {
  const asset = ASSETS[`${process.platform}:${process.arch}`];
  if (!asset)
    throw new Error(
      `No Vera binary for ${process.platform}/${process.arch}; install Vera ${VERSION} yourself`,
    );
  options.onProgress?.(`Downloading Vera ${VERSION}\n`);
  const response = await fetch(`${RELEASE}/${asset.name}`, { signal: options.signal });
  if (!response.ok) throw new Error(`Vera download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Vera download checksum mismatch");
  const temp = await mkdtemp(join(tmpdir(), "pi-vera-"));
  try {
    const archive = join(temp, asset.name);
    await writeFile(archive, bytes);
    await run("tar", ["-xf", archive, "-C", temp], temp, { ...options, onProgress: undefined });
    const source = join(temp, asset.name.replace(/\.(?:tar\.gz|zip)$/u, ""), binaryName());
    const targetDir = join(managedRoot(options.env ?? process.env), "bin");
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, binaryName());
    const staging = await mkdtemp(join(targetDir, ".vera-install-"));
    try {
      const staged = join(staging, binaryName());
      await copyFile(source, staged, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") await chmod(staged, 0o755);
      try {
        await link(staged, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const version = await run(target, ["--version"], temp, { ...options, onProgress: undefined });
    if (version.trim() !== `vera ${VERSION}`)
      throw new Error(`Managed Vera is not version ${VERSION}`);
    return target;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function checkUpdate(output: string): void {
  const result: unknown = JSON.parse(output);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid Vera indexing output");
  if (
    "parse_errors" in result &&
    (!Array.isArray(result.parse_errors) || result.parse_errors.length > 0)
  )
    throw new Error("Vera could not parse all indexed files");
  for (const key of ["files_deferred", "embedding_failed_batches", "embedding_timeouts"]) {
    if (
      key in result &&
      (typeof result[key as keyof typeof result] !== "number" ||
        (result[key as keyof typeof result] as number) !== 0)
    )
      throw new Error("Vera did not update all indexed files");
  }
}

/** Explicit opt-in creates or updates only this project's index using local CPU embeddings. */
export async function indexVeraProject(
  cwd: string,
  options: BackendOptions = {},
): Promise<ProjectStatus> {
  const project = projectPath(cwd);
  const executable = (await findVera(options)) ?? (await installVera(options));
  if (!(await modelReady(options))) {
    options.onProgress?.("Preparing Vera local model\n");
    await run(executable, ["setup", "--potion-code", "--yes"], project, options);
    if (!(await modelReady(options))) throw new Error("Vera did not prepare its local model");
  }
  await requireLocalConfiguration(options);
  options.onProgress?.("Indexing project with Vera\n");
  let exists = false;
  try {
    exists = (await stat(join(project, ".vera"))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists && !(await indexValid(executable, project, options)))
    throw new Error("Existing Vera index is unusable");
  checkUpdate(
    await run(executable, [exists ? "update" : "index", ".", "--potion-code", "--json"], project, {
      ...options,
      onProgress: undefined,
    }),
  );
  const status = await inspectVeraProject(project, options);
  if (!status.usable) throw new Error("Vera did not create a usable project index");
  return status;
}

function inside(base: string, path: string): boolean {
  const a = process.platform === "win32" ? base.toLowerCase() : base;
  const b = process.platform === "win32" ? path.toLowerCase() : path;
  return a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** Search fresh local Vera results; scope filtering is best-effort before ranking. */
export async function searchVeraProject(
  cwd: string,
  query: string,
  options: BackendOptions & {
    readonly limit?: number;
    readonly path?: string;
    readonly include?: string;
    readonly exclude?: string;
  } = {},
): Promise<string> {
  const project = projectPath(cwd);
  if (!query.trim()) throw new Error("A semantic search query is required");
  const status = await inspectVeraProject(project, options);
  if (!status.usable || !status.executable)
    throw new Error("No usable Vera index for this project");
  await requireLocalConfiguration(options);
  const limit = options.limit ?? 15;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid result limit");
  let scope: string | undefined;
  let singleFile = false;
  if (options.path !== undefined) {
    if (!options.path.trim() || /^[a-z][a-z\d+.-]*:\/\//iu.test(options.path))
      throw new Error("Invalid semantic search scope");
    const target = resolve(project, options.path);
    const root = await realpath(project);
    let actual: string;
    try {
      actual = await realpath(target);
    } catch {
      throw new Error("Invalid semantic search scope: path does not exist");
    }
    if (!inside(project, target) || !inside(root, actual))
      throw new Error("Invalid semantic search scope: outside project");
    const info = await stat(actual);
    if (!info.isFile() && !info.isDirectory())
      throw new Error("Invalid semantic search scope: not a file or directory");
    singleFile = info.isFile();
    scope = relative(project, target) || ".";
  }
  checkUpdate(
    await run(status.executable, ["update", ".", "--potion-code", "--json"], project, {
      ...options,
      onProgress: undefined,
    }),
  );
  const filtered =
    scope !== undefined || options.include !== undefined || options.exclude !== undefined;
  let allowed: Set<string> | undefined;
  if (filtered) {
    const files = await searchFiles(
      "",
      { query: "", path: scope, include: options.include, exclude: options.exclude, limit: 50_000 },
      project,
      options.signal,
    );
    if (!files.complete)
      throw new Error("Too many files to apply semantic search filters; narrow the scope");
    allowed = new Set(files.files.map((file) => file.split(sep).join("/")));
  }
  const warning = filtered
    ? "Vera may omit relevant matches when a scope or filter is used.\n"
    : "";
  if (allowed?.size === 0) return `${warning}No semantic search results.`;
  const args = ["search", "--json", "--potion-code", "--limit", String(singleFile ? 100 : limit)];
  const paths = allowed ? [...allowed] : [];
  if (
    paths.length &&
    paths.length <= 512 &&
    paths.reduce((sum, value) => sum + Buffer.byteLength(value), 0) < 48_000
  ) {
    for (const path of paths) args.push("--path", path);
  } else if (scope && scope !== ".") args.push("--path", scope.split(sep).join("/"));
  args.push("--", query);
  const output: unknown = JSON.parse(
    await run(status.executable, args, project, { ...options, onProgress: undefined }),
  );
  if (!Array.isArray(output)) throw new Error("Invalid Vera search output");
  const files = new Map<string, Set<string>>();
  for (const item of output as unknown[]) {
    if (
      !item ||
      typeof item !== "object" ||
      !("file_path" in item) ||
      typeof item.file_path !== "string" ||
      !("line_start" in item) ||
      typeof item.line_start !== "number" ||
      !("line_end" in item) ||
      typeof item.line_end !== "number" ||
      !Number.isInteger(item.line_start) ||
      !Number.isInteger(item.line_end) ||
      item.line_start < 1 ||
      item.line_end < item.line_start
    )
      throw new Error("Invalid Vera search output");
    const absolute = resolve(project, item.file_path);
    if (!inside(project, absolute)) throw new Error("Vera returned a file outside the project");
    const file = relative(project, absolute).split(sep).join("/");
    if (allowed && !allowed.has(file)) continue;
    const ranges = files.get(file) ?? new Set<string>();
    ranges.add(`${item.line_start}-${item.line_end}`);
    files.set(file, ranges);
  }
  if (!files.size) return `${warning}No semantic search results.`;
  if (singleFile) {
    const lines: string[] = [];
    for (const [file, ranges] of files) {
      const selected = [...ranges];
      lines.push(...selected.slice(0, 15).map((range) => `${file}:${range}`));
      if (selected.length > 15)
        lines.push(`${selected.length - 15} additional retrieved ranges omitted`);
    }
    if (output.length === 100)
      lines.push("More candidates may exist beyond Vera's retrieval limit");
    return `${warning}Approximate ranges (read before editing):\n${lines.join("\n")}`;
  }
  return (
    warning +
    [...files].map(([file, ranges]) => `${file}  (${ranges.size} retrieved candidates)`).join("\n")
  );
}
