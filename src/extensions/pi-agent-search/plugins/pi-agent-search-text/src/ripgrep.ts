import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
