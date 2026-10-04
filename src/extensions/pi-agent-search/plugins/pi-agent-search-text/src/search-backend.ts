import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { resolveRipgrepExecutable } from "#src/ripgrep.js";

import { type SearchCondition, satisfiesSearchCondition } from "#src/search-query.js";
import type { TextSearchMatch } from "#src/search-session.js";

export interface TextSearchRequest {
  readonly query: string;
  readonly path?: string;
  readonly include?: string;
  readonly exclude?: string;
  readonly regex?: boolean;
  /** Line conditions checked separately from the match pattern, without generated lookaround. */
  readonly condition?: SearchCondition;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly limit?: number;
}

export interface TextSearchBackendResult {
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
}

interface RipgrepMatchEvent {
  readonly type: "match";
  readonly data: {
    readonly path: { readonly text?: string };
    readonly lines: { readonly text?: string };
    readonly line_number: number;
    readonly submatches: readonly {
      readonly start: number;
      readonly end: number;
    }[];
  };
}

export async function searchText(
  request: TextSearchRequest,
  cwd: string,
  signal?: AbortSignal,
  budget?: SearchCaptureBudget,
): Promise<TextSearchBackendResult> {
  if (request.query.length === 0) {
    throw new Error("Search query must not be empty.");
  }

  if (/\r|\n/u.test(request.query)) {
    throw new Error("Search supports one-line patterns only.");
  }

  if (request.condition !== undefined) return searchBoolean(request, cwd, signal);
  return searchPattern(request, cwd, signal, undefined, budget);
}

/** Reuse ordinary text-search scope, ignores, and glob parsing for the extra scan. */
export async function ripgrepScope(request: TextSearchRequest, cwd: string) {
  const target = path.resolve(cwd, stripFilePrefix(request.path ?? "."));
  const directory = (await stat(target)).isDirectory();
  return {
    cwd: directory ? target : path.dirname(target),
    target: directory ? "." : path.basename(target),
    arguments: [
      "--no-config",
      "--no-ignore-parent",
      "--color=never",
      ...splitGlobList(request.include).flatMap((glob) => ["--glob", glob]),
      ...splitGlobList(request.exclude).flatMap((glob) => ["--glob", `!${glob}`]),
    ],
  };
}
/** Internal capture bounds for candidate verification; ordinary Search keeps its full capture. */
export interface SearchCaptureBudget {
  readonly matches: number;
  readonly bytes: number;
}
type MatchingLine = (source: string, lineNumber: number) => void;

/** Search exactly the supplied source text with the same ripgrep engine as file searches. */
export async function searchTextContent(
  request: TextSearchRequest,
  content: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextSearchBackendResult> {
  if (request.condition !== undefined)
    throw new Error("Boolean scoped search is not available yet.");
  if (/\r|\n/u.test(request.query)) throw new Error("Search supports one-line patterns only.");
  const result = await runRipgrep(
    [
      "--json",
      "--no-config",
      "--color=never",
      "--with-filename",
      "--line-number",
      ...(request.regex === true ? ["--engine", "auto"] : ["--fixed-strings"]),
      request.caseSensitive === true ? "--case-sensitive" : "--ignore-case",
      ...(request.wholeWord === true ? ["--word-regexp"] : []),
      "--",
      request.query,
      "-",
    ],
    cwd,
    signal,
    undefined,
    undefined,
    // An empty source still has one position. Ripgrep excludes the record delimiter from matches.
    content.length === 0 ? "\n" : content,
  );
  return content.length === 0
    ? {
        ...result,
        matches: result.matches.filter(
          (match) => match.lineNumber === 1 && match.startColumn === 0 && match.endColumn === 0,
        ),
      }
    : result;
}

async function searchPattern(
  request: TextSearchRequest,
  cwd: string,
  signal?: AbortSignal,
  onLine?: MatchingLine,
  budget?: SearchCaptureBudget,
): Promise<TextSearchBackendResult> {
  const scope = await ripgrepScope(request, cwd);
  const searchCwd = scope.cwd;
  const commonArguments = [
    "--json",
    "--with-filename",
    "--line-number",
    request.caseSensitive === true ? "--case-sensitive" : "--ignore-case",
    ...(request.wholeWord === true ? ["--word-regexp"] : []),
    ...scope.arguments,
    "--",
    request.query,
    scope.target,
  ];

  if (request.regex !== true) {
    return runRipgrep(["--fixed-strings", ...commonArguments], searchCwd, signal, onLine, budget);
  }

  try {
    return await runRipgrep(
      ["--engine", "auto", ...commonArguments],
      searchCwd,
      signal,
      onLine,
      budget,
    );
  } catch (error) {
    if (!isPcre2MatchLimitError(error)) {
      if (
        error instanceof Error &&
        /PCRE2 is not available|does not support PCRE2/iu.test(error.message)
      ) {
        throw new Error(
          "This regex requires PCRE2. Install ripgrep with PCRE2 support or simplify the regex.",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return await runRipgrep(
        ["--engine", "default", ...commonArguments],
        searchCwd,
        signal,
        onLine,
        budget,
      );
    } catch (fallbackError) {
      if (signal?.aborted) throw fallbackError;
      throw new AggregateError(
        [error, fallbackError],
        "Regex exceeded the PCRE2 match limit and cannot run with the default engine. Narrow the search or simplify the regex.",
        { cause: fallbackError },
      );
    }
  }
}

async function searchBoolean(
  request: TextSearchRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextSearchBackendResult> {
  const condition = request.condition;
  if (condition === undefined) throw new Error("Boolean search requires a line condition.");
  const patterns = new Set<string>();
  function collect(node: SearchCondition): void {
    if (node.kind === "term") {
      patterns.add(node.value);
      return;
    }
    collect(node.left);
    collect(node.right);
  }
  collect(condition);
  const { condition: _condition, ...scope } = request;
  const present = new Map<string, Set<string>>();
  const lineKey = (match: TextSearchMatch): string =>
    JSON.stringify([match.source, match.lineNumber]);
  for (const pattern of patterns) {
    signal?.throwIfAborted();
    const lines = new Set<string>();
    await searchPattern(
      { ...scope, query: pattern, regex: true, wholeWord: false },
      cwd,
      signal,
      (source, lineNumber) => lines.add(JSON.stringify([source, lineNumber])),
    );
    present.set(pattern, lines);
  }
  const result = await searchText(scope, cwd, signal);
  const selected = new Set<string>();
  const matches = result.matches.filter((match) => {
    const key = lineKey(match);
    if (
      selected.has(key) ||
      !satisfiesSearchCondition(condition, (pattern) => present.get(pattern)?.has(key) === true)
    )
      return false;
    selected.add(key);
    return true;
  });
  return { ...result, matches };
}
function runRipgrep(
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  onLine?: MatchingLine,
  budget?: SearchCaptureBudget,
  input?: string,
): Promise<TextSearchBackendResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRipgrepExecutable(), arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    let bytes = 0;
    let limited = false;
    if (budget !== undefined)
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > budget.bytes) {
          limited = true;
          child.kill();
        }
      });
    const output = createInterface({ input: child.stdout });
    child.stdin.on("error", () => {
      /* The process close/error event reports failed searches. */
    });
    child.stdin.end(input);
    const matches: TextSearchMatch[] = [];
    let stderr = "";
    let parseError: unknown;

    const abort = (): void => {
      child.kill();
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      output.close();
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    output.on("line", (line) => {
      if (limited || parseError !== undefined || line.length === 0) {
        return;
      }

      try {
        const event = JSON.parse(line) as { readonly type?: unknown };

        if (event.type !== "match") {
          return;
        }

        if (onLine !== undefined) {
          const { path: source, line_number: lineNumber } = (event as RipgrepMatchEvent).data;
          if (source.text !== undefined && Number.isSafeInteger(lineNumber)) {
            onLine(path.resolve(cwd, source.text), lineNumber);
          }
          return;
        }
        for (const match of matchesFromEvent(event as RipgrepMatchEvent, cwd)) {
          if (budget !== undefined && matches.length === budget.matches) {
            limited = true;
            child.kill();
            break;
          }
          matches.push(match);
        }
      } catch (error) {
        parseError = error;
        child.kill();
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();

      if (signal?.aborted === true) {
        const error = new Error("Search was aborted.");
        error.name = "AbortError";
        reject(error);
        return;
      }

      if (parseError !== undefined) {
        reject(new Error("Unable to parse ripgrep search output.", { cause: parseError }));
        return;
      }

      if (!limited && code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}.`));
        return;
      }

      matches.sort(compareMatches);
      resolve({ matches, complete: !limited });
    });

    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted === true) {
      abort();
    }
  });
}

function isPcre2MatchLimitError(error: unknown): boolean {
  return (
    error instanceof Error && /PCRE2: error matching: match limit exceeded/iu.test(error.message)
  );
}

function matchesFromEvent(event: RipgrepMatchEvent, cwd: string): TextSearchMatch[] {
  const source = event.data.path.text;
  const rawLine = event.data.lines.text;

  if (
    source === undefined ||
    rawLine === undefined ||
    !Number.isSafeInteger(event.data.line_number)
  ) {
    return [];
  }

  const lineText = rawLine.replace(/(?:\r\n|\n)$/u, "");
  const lineBuffer = Buffer.from(rawLine);
  const matches: TextSearchMatch[] = [];

  for (const submatch of event.data.submatches) {
    if (submatch.start < 0 || submatch.end < submatch.start || submatch.end > lineBuffer.length) {
      continue;
    }

    const startColumn = lineBuffer.subarray(0, submatch.start).toString("utf8").length;
    const endColumn = lineBuffer.subarray(0, submatch.end).toString("utf8").length;
    matches.push({
      source: path.resolve(cwd, source),
      lineNumber: event.data.line_number,
      startColumn,
      endColumn,
      matchedText: lineText.slice(startColumn, endColumn),
      lineText,
    });
  }

  return matches;
}

function splitGlobList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  const globs: string[] = [];
  let depth = 0;
  let current = "";

  for (const character of value) {
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && (character === "," || /\s/u.test(character))) {
      if (current.length > 0) {
        globs.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    globs.push(current);
  }

  return globs;
}

function stripFilePrefix(source: string): string {
  return source.startsWith("@") ? source.slice(1) : source;
}

function compareMatches(left: TextSearchMatch, right: TextSearchMatch): number {
  return (
    left.source.localeCompare(right.source) ||
    left.lineNumber - right.lineNumber ||
    left.startColumn - right.startColumn ||
    left.endColumn - right.endColumn
  );
}
