import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ripgrep arguments that list the files under the working directory whose text has `word` as a
 * whole word, among files with one of `extensions`. Paths are printed relative to it, with `/`.
 */
export function filesContainingArguments(
  word: string,
  extensions: readonly string[],
): readonly string[] {
  return [
    "--files-with-matches",
    "--fixed-strings",
    "--word-regexp",
    "--no-config",
    "--no-messages",
    "--path-separator=/",
    ...extensions.flatMap((extension) => ["--glob", `*${extension}`]),
    "--regexp",
    word,
    "--",
    ".",
  ];
}

/** Paths from ripgrep output, relative to its working directory and without the `./` prefix. */
export function filesContainingOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/u, "").replace(/^\.\//u, ""))
    .filter((line) => line.length > 0);
}

/** Pi's bundled ripgrep, or `rg` from PATH, as the text search uses it. */
function ripgrep(): string {
  const directory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const bundled = path.join(directory, "bin", process.platform === "win32" ? "rg.exe" : "rg");
  return existsSync(bundled) ? bundled : "rg";
}

/** Absolute paths of the local files under `root` whose text has `word` as a whole word. */
export function localFilesContaining(
  root: string,
  word: string,
  extensions: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      ripgrep(),
      [...filesContainingArguments(word, extensions)],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, ...(signal && { signal }) },
      (error, stdout, stderr) => {
        // ripgrep exits with 1 when no file matches.
        if (error && error.code !== 1) {
          reject(
            signal?.aborted
              ? signal.reason
              : new Error(`Listing files that contain ${word} failed: ${stderr || error.message}`),
          );
          return;
        }
        resolve(filesContainingOutput(stdout).map((file) => path.join(root, file)));
      },
    );
  });
}
