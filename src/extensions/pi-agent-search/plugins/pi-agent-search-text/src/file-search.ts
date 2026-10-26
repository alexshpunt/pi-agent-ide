import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

import { resolveRipgrepExecutable } from "#src/ripgrep.js";

import { splitGlobList, type SearchRequest } from "pi-agent-search/api/search";
import type { SearchEnvironment } from "pi-agent-search/api/search";

export interface FileSearchResult {
  readonly files: readonly string[];
  readonly complete: boolean;
}

export async function searchFiles(
  query: string,
  request: SearchRequest,
  cwd: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
): Promise<FileSearchResult> {
  const limit = request.limit ?? 100;
  const arguments_ = [
    "--files",
    "--hidden",
    "--no-config",
    "--no-ignore-parent",
    "--glob",
    "!.git/**",
  ];

  for (const include of splitGlobList(request.include)) {
    arguments_.push("--glob", include);
  }

  for (const exclude of splitGlobList(request.exclude)) {
    arguments_.push("--glob", `!${exclude}`);
  }

  if (environment !== undefined) {
    const target = environment.resolve(cwd, request.path ?? ".");
    const directory = await environment.isDirectory(target, signal);
    const searchCwd = directory ? target : environment.dirname(target);
    arguments_.push("--", directory ? "." : `./${environment.basename(target)}`);
    const found = firstFiles(limit);
    const result = await environment.runLines(
      arguments_,
      searchCwd,
      (file) => {
        const relative = file.replace(/^\.\//u, "");
        if (matchFile(relative, query)) found.add(environment.resolve(searchCwd, file));
      },
      signal,
    );
    signal?.throwIfAborted();
    if (result.code !== 0 && result.code !== 1)
      throw new Error(result.stderr || "File search failed.");
    return found.result();
  }
  if (request.path?.includes("://") || cwd.includes("://"))
    throw new Error("No search environment owns this scope.");
  if (request.path !== undefined) arguments_.push(request.path);

  return new Promise((resolve, reject) => {
    const child = spawn(resolveRipgrepExecutable(), arguments_, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A large tree lists more paths than one string can hold, so lines are matched as they arrive.
    const found = firstFiles(limit);
    let failure: Error | undefined;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < maximumStderrLength) stderr += chunk;
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line.length === 0 || failure !== undefined) return;
      try {
        const file = path.relative(cwd, path.resolve(cwd, line));
        if (matchFile(file, query)) found.add(file);
      } catch (error) {
        failure =
          error instanceof Error ? error : new Error("File search failed.", { cause: error });
        child.kill("SIGTERM");
      }
    });
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);

      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("File search aborted"));
        return;
      }

      if (failure !== undefined) {
        reject(failure);
        return;
      }

      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `rg exited with code ${String(code)}`));
        return;
      }

      resolve(found.result());
    });
  });
}

const maximumStderrLength = 64 * 1024;
const collator = new Intl.Collator();

/** Keep the first `limit` matches in sort order and count the rest, so memory stays bounded. */
function firstFiles(limit: number): {
  add(file: string): void;
  result(): FileSearchResult;
} {
  const files: string[] = [];
  let count = 0;
  return {
    add(file) {
      count += 1;
      const last = files.at(-1);
      if (files.length >= limit && (last === undefined || collator.compare(file, last) >= 0))
        return;
      let low = 0;
      let high = files.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const current = files[middle];
        if (current !== undefined && collator.compare(current, file) <= 0) low = middle + 1;
        else high = middle;
      }
      files.splice(low, 0, file);
      if (files.length > limit) files.pop();
    },
    result: () => ({ files, complete: count <= limit }),
  };
}

function matchFile(file: string, query: string): boolean {
  if (/[*?[\]{}]/u.test(query)) {
    const pattern = query.replace(/^\.\//u, "");
    return path.matchesGlob(pattern.includes("/") ? file : path.basename(file), pattern);
  }
  return fuzzyMatch(file, query);
}

function fuzzyMatch(file: string, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  let index = 0;
  const candidate = file.toLowerCase();

  for (const character of query.toLowerCase()) {
    index = candidate.indexOf(character, index);

    if (index === -1) {
      return false;
    }

    index += 1;
  }

  return true;
}
