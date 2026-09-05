import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { LanguageDefinition } from "#src/api/tool-catalog.js";

const execFileAsync = promisify(execFile);
const skippedDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "build",
  "dist",
  "coverage",
  ".cache",
  ".next",
  "target",
]);

/**
Collects project files while respecting Git ignores when Git is available.
*/
export async function collectProjectFiles(
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  try {
    const result = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,

        signal,
      },
    );
    const files = result.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => path.resolve(cwd, file))
      .filter((file) => !isManagedIdeConfig(file));
    signal?.throwIfAborted();
    return files.length > 0 ? files : await walk(cwd, signal);
  } catch {
    signal?.throwIfAborted();
    return walk(cwd, signal);
  }
}

/**
Maps registered language definitions to matching project files.
*/
export function detectProjectLanguages(
  files: readonly string[],
  languages: readonly LanguageDefinition[],
): ReadonlyMap<string, readonly string[]> {
  const detected = new Map<string, string[]>();

  for (const language of languages) {
    const extensions = new Set(language.extensions.map((extension) => extension.toLowerCase()));
    const names = new Set(language.fileNames);
    const matches = files.filter(
      (file) =>
        !file.split(path.sep).join("/").includes("/.pi/pi-agent-ide/") &&
        (extensions.has(path.extname(file).toLowerCase()) || names.has(path.basename(file))),
    );

    if (matches.length > 0) {
      detected.set(language.id, matches);
    }
  }

  return detected;
}

async function walk(directory: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }

    const absolute = path.join(directory, entry.name);

    if (isManagedIdeConfig(absolute)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await walk(absolute, signal)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }

  return files;
}

function isManagedIdeConfig(file: string): boolean {
  return file.split(path.sep).join("/").includes("/.pi/pi-agent-ide/");
}
