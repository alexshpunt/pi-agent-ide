import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SearchEnvironment } from "pi-agent-search/api/search";

/** Resolve Pi's bundled ripgrep binary, falling back to the system PATH. */
export function resolveRipgrepExecutable(
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  platform: NodeJS.Platform = process.platform,
): string {
  const bundledExecutable = path.join(
    agentDirectory,
    "bin",
    platform === "win32" ? "rg.exe" : "rg",
  );
  return existsSync(bundledExecutable) ? bundledExecutable : "rg";
}

/**
 * Ripgrep arguments for the ignore files above a directory scope. The scope follows them, as a
 * search from the repository root does, so nested `node_modules` and build output stay skipped.
 * A scope that Git ignores itself, such as a build directory, leaves them out: ripgrep would
 * otherwise skip every file in it. Without an answer from Git, they stay out as well.
 */
export async function parentIgnoreArguments(
  directory: string,
  environment?: SearchEnvironment,
  signal?: AbortSignal,
): Promise<string[]> {
  const arguments_ = ["check-ignore", "-q", "."];
  let code: number | undefined;
  try {
    if (environment === undefined) code = await localExitCode("git", arguments_, directory, signal);
    else if (environment.execute !== undefined)
      code = (await environment.execute("git", arguments_, directory, signal)).code;
  } catch {
    // No Git, no repository or an unreachable owner: keep the parents' rules out.
  }
  signal?.throwIfAborted();
  // `git check-ignore` exits with 1 when the path is not ignored.
  return code === 1 ? [] : ["--no-ignore-parent"];
}

function localExitCode(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      arguments_,
      { cwd, windowsHide: true, timeout: 10_000, ...(signal === undefined ? {} : { signal }) },
      (error) => {
        if (error === null) resolve(0);
        else if (typeof error.code === "number") resolve(error.code);
        else reject(error);
      },
    );
  });
}

/** Paths ripgrep could not read while it searched the rest of its scope. */
export interface UnreadablePaths {
  readonly count: number;
  /** The first report: the path ripgrep printed, resolved by the caller, and its error. */
  readonly first: { readonly path: string; readonly error: string };
}

const maximumStderrLength = 64 * 1024;
// Ripgrep reports a path it cannot open or walk as `rg: <path>: <error> (os error <n>)` and goes
// on. Errors that stop it, such as a regex or glob that does not parse, have no OS error code.
const unreadablePathLine = /^rg: (.+?): (.+\(os error \d+\))$/u;

/**
 * Sort ripgrep's stderr, as it arrives, into per-path read errors and other text, with bounded
 * memory. Exit code 2 with read errors means ripgrep searched every other path, unless a PCRE2
 * matching error also failed a file. Other per-file warnings, such as an ignore-file glob that
 * does not parse, do not stop it either.
 */
export class RipgrepStderr {
  #pending = "";
  #text = "";
  #other = "";
  #matchingFailed = false;
  #count = 0;
  #first: UnreadablePaths["first"] | undefined;

  readonly #resolvePath: (printed: string) => string;

  /** `resolvePath` turns a path as ripgrep printed it into the path the result shows. */
  constructor(resolvePath: (printed: string) => string = (printed) => printed) {
    this.#resolvePath = resolvePath;
  }

  write(chunk: string): void {
    if (this.#text.length < maximumStderrLength)
      this.#text += chunk.slice(0, maximumStderrLength - this.#text.length);
    const lines = (this.#pending + chunk).split(/\r?\n/u);
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  /**
   * The search's error message: what ripgrep printed besides read errors, so a long list of
   * unreadable paths neither hides nor cuts off the cause; all of its stderr when there is nothing
   * else.
   */
  get message(): string {
    this.#flush();
    return this.#other.trim() || this.#text.trim();
  }

  /**
   * The paths ripgrep could not read when it finished with code 2, or `undefined` when the run
   * failed or had no such paths. A PCRE2 matching error, such as the match limit, keeps the run
   * failed, so the caller can retry it with the default engine.
   */
  unreadable(code: number | null): UnreadablePaths | undefined {
    this.#flush();
    if (code !== 2 || this.#first === undefined || this.#matchingFailed) return undefined;
    return { count: this.#count, first: this.#first };
  }

  /** Whether the run failed: an exit code other than 0 or 1 that read errors do not explain. */
  failed(code: number | null): boolean {
    return code !== 0 && code !== 1 && this.unreadable(code) === undefined;
  }

  #flush(): void {
    this.#line(this.#pending);
    this.#pending = "";
  }

  #line(line: string): void {
    if (line.length === 0) return;
    const unreadable = unreadablePathLine.exec(line);
    if (unreadable === null) {
      this.#matchingFailed ||= /PCRE2: error matching/iu.test(line);
      if (this.#other.length < maximumStderrLength) this.#other += `${line}\n`;
      return;
    }
    this.#count += 1;
    this.#first ??= { path: this.#resolvePath(unreadable[1] ?? ""), error: unreadable[2] ?? "" };
  }
}

/** Add the unreadable paths of another search of a separate scope. */
export function mergeUnreadablePaths(
  left: UnreadablePaths | undefined,
  right: UnreadablePaths | undefined,
): UnreadablePaths | undefined {
  if (left === undefined || right === undefined) return left ?? right;
  return { count: left.count + right.count, first: left.first };
}
