import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  mergeUnreadablePaths,
  parentIgnoreArguments,
  resolveRipgrepExecutable,
  RipgrepStderr,
  type UnreadablePaths,
} from "#src/ripgrep.ts";

import { splitGlobList, type SearchRequest } from "pi-agent-search/api/search";
import type { SearchEnvironment } from "pi-agent-search/api/search";
import {
  snapshotOnToolDeadline,
  toolDeadlineFailure,
  trackToolCleanup,
  withStructuredResult,
} from "pi-agent-resource";
import { searchDataSchema } from "pi-agent-search/api/search";

export interface FileSearchResult {
  readonly files: readonly string[];
  readonly complete: boolean;
  /** Paths ripgrep could not read; files below them are missing. */
  readonly unreadable?: UnreadablePaths;
}

/** List matching paths, stopping the walk once the requested number has been found. */
export async function searchFiles(
  query: string,
  request: SearchRequest,
  cwd: string,
  parent?: AbortSignal,
  environment?: SearchEnvironment,
): Promise<FileSearchResult> {
  const limit = request.limit ?? 100;
  // Ascending path sort orders entries within each directory as ripgrep walks it. It does
  // not collect the tree first or buffer stdout until the walk finishes.
  const arguments_ = [
    "--files",
    "--sort",
    "path",
    "--line-buffered",
    "--hidden",
    "--no-config",
    "--glob",
    "!.git/**",
  ];
  for (const include of splitGlobList(request.include)) arguments_.push("--glob", include);
  for (const exclude of splitGlobList(request.exclude)) arguments_.push("--glob", `!${exclude}`);

  const roots = request.paths ?? (request.path === undefined ? [] : [request.path]);
  const reachedLimit = Symbol("file search match limit");
  const stop = new AbortController();
  const signal = parent === undefined ? stop.signal : AbortSignal.any([parent, stop.signal]);
  const found = new Set<string>();
  snapshotOnToolDeadline((error) => {
    const files = [...found];
    const result = toolDeadlineFailure(error);
    return withStructuredResult(
      {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: [`Incomplete file list (${files.length} found)`, ...files.slice(0, 100)].join(
              "\n",
            ),
          },
        ],
      },
      searchDataSchema,
      {
        status: "partial",
        data: { kind: "files", complete: false, files },
        errors: [{ code: error.code, source: error.target, message: error.message }],
      },
      { maxBytes: Infinity },
    );
  });
  let unreadable: UnreadablePaths | undefined;
  const accept = (relative: string, source: string): void => {
    if (signal.aborted || !matchFile(relative, query)) return;
    found.add(source);
    if (found.size >= limit) stop.abort(reachedLimit);
  };
  const recordExit = (stderr: RipgrepStderr, code: number | null): void => {
    if (!stop.signal.aborted && stderr.failed(code))
      throw new Error(stderr.message || `rg exited with code ${String(code)}`);
    unreadable = mergeUnreadablePaths(
      unreadable,
      stderr.unreadable(stop.signal.aborted ? 2 : code),
    );
  };

  try {
    signal.throwIfAborted();
    if (environment !== undefined) {
      // Each root is listed from its own directory, so a glob with / matches relative to it.
      const targets = (roots.length === 0 ? ["."] : roots)
        .map((root) => environment.resolve(cwd, root))
        .toSorted();
      for (const target of targets) {
        const directory = await environment.isDirectory(target, signal);
        const searchCwd = directory ? target : environment.dirname(target);
        const runArgs = [
          ...arguments_,
          ...(directory ? await parentIgnoreArguments(target, environment, signal) : []),
          "--",
          directory ? "." : `./${environment.basename(target)}`,
        ];
        signal.throwIfAborted();
        const result = await environment.runLines(
          runArgs,
          searchCwd,
          (file) => {
            const relative = file.replace(/^\.\//u, "");
            accept(relative, environment.resolve(searchCwd, file));
          },
          signal,
        );
        const stderr = new RipgrepStderr((printed) => environment.resolve(searchCwd, printed));
        stderr.write(result.stderr);
        recordExit(stderr, result.code);
        signal.throwIfAborted();
      }
    } else {
      if (roots.some((root) => root.includes("://")) || cwd.includes("://"))
        throw new Error("No search environment owns this scope.");
      const sortedRoots = roots.toSorted((a, b) =>
        comparePaths(path.resolve(cwd, a), path.resolve(cwd, b)),
      );
      arguments_.push(...(await localParentIgnoreArguments(sortedRoots, cwd, signal)));
      if (sortedRoots.length > 0) arguments_.push("--", ...sortedRoots);
      signal.throwIfAborted();
      const stderr = new RipgrepStderr((printed) => path.resolve(cwd, printed));
      const code = await runLocalLines(arguments_, cwd, stderr, signal, (line) => {
        const file = path.relative(cwd, path.resolve(cwd, line));
        accept(file, file);
      });
      recordExit(stderr, code);
      signal.throwIfAborted();
    }
  } catch (error) {
    parent?.throwIfAborted();
    if (signal.reason !== reachedLimit) throw error;
  }
  return {
    files: [...found],
    complete: !stop.signal.aborted,
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runLocalLines(
  args: readonly string[],
  cwd: string,
  stderr: RipgrepStderr,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRipgrepExecutable(), args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let failure: unknown;
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const abort = (): void => {
      trackToolCleanup(closed);
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.write(chunk));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (line === "" || signal.aborted || failure !== undefined) return;
      try {
        onLine(line);
      } catch (error) {
        failure = error;
        abort();
      }
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else resolve(code);
    });
  });
}
/**
 * One run lists every root, so it follows the ignore files above them only when each directory
 * root does. Ripgrep lists a file root even when an ignore file names it.
 */
async function localParentIgnoreArguments(
  roots: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const perRoot = await Promise.all(
    (roots.length === 0 ? ["."] : roots).map(async (root) => {
      const target = path.resolve(cwd, root);
      const directory = await stat(target).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      return directory ? parentIgnoreArguments(target, undefined, signal) : [];
    }),
  );
  return perRoot.some((arguments_) => arguments_.length > 0) ? ["--no-ignore-parent"] : [];
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
