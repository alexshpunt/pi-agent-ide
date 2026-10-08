import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { SearchEnvironment } from "pi-agent-search/api/search";
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
  environment?: SearchEnvironment,
): Promise<TextSearchBackendResult> {
  if (request.query.length === 0) {
    throw new Error("Search query must not be empty.");
  }

  if (/\r|\n/u.test(request.query)) {
    throw new Error("Search supports one-line patterns only.");
  }

  if (request.condition !== undefined) return searchBoolean(request, cwd, signal, environment);
  return searchPattern(request, cwd, signal, undefined, environment);
}

/** Search already-owned text without reading neighboring files or another backend. */
export async function searchTextContent(
  request: TextSearchRequest,
  content: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<TextSearchBackendResult> {
  if (request.condition !== undefined)
    throw new Error("Boolean text queries are unsupported for result scopes.");
  if (request.query.length === 0 || /\r|\n/u.test(request.query))
    throw new Error("Search requires a non-empty one-line pattern.");
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
    content.length === 0 ? "\n" : content,
  );
  return content.length === 0 ? { matches: [], complete: true } : result;
}
type MatchingLine = (source: string, lineNumber: number) => void;

async function searchPattern(
  request: TextSearchRequest,
  cwd: string,
  signal?: AbortSignal,
  onLine?: MatchingLine,
  environment?: SearchEnvironment,
): Promise<TextSearchBackendResult> {
  if (environment === undefined && (request.path?.includes("://") || cwd.includes("://")))
    throw new Error("No search environment owns this scope.");
  const target =
    environment?.resolve(cwd, stripFilePrefix(request.path ?? ".")) ??
    path.resolve(cwd, stripFilePrefix(request.path ?? "."));
  const directory =
    environment === undefined
      ? (await stat(target)).isDirectory()
      : await environment.isDirectory(target, signal);
  const searchCwd = directory ? target : (environment?.dirname(target) ?? path.dirname(target));
  const commonArguments = [
    "--json",
    "--no-config",
    "--no-ignore-parent",
    "--color=never",
    "--with-filename",
    "--line-number",
    request.caseSensitive === true ? "--case-sensitive" : "--ignore-case",
    ...(request.wholeWord === true ? ["--word-regexp"] : []),
    ...splitGlobList(request.include).flatMap((glob) => ["--glob", glob]),
    ...splitGlobList(request.exclude).flatMap((glob) => ["--glob", `!${glob}`]),
    "--",
    request.query,
    directory ? "." : `./${environment?.basename(target) ?? path.basename(target)}`,
  ];

  if (request.regex !== true) {
    return runRipgrep(
      ["--fixed-strings", ...commonArguments],
      searchCwd,
      signal,
      onLine,
      environment,
    );
  }

  try {
    return await runRipgrep(
      ["--engine", "auto", ...commonArguments],
      searchCwd,
      signal,
      onLine,
      environment,
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
        environment,
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
  environment?: SearchEnvironment,
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
      environment,
    );
    present.set(pattern, lines);
  }
  const result = await searchText(scope, cwd, signal, environment);
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
async function runRipgrep(
  arguments_: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  onLine?: MatchingLine,
  environment?: SearchEnvironment,
  input?: string,
): Promise<TextSearchBackendResult> {
  const matches: TextSearchMatch[] = [];
  const resolveSource = (source: string): string =>
    environment?.resolve(cwd, source) ?? path.resolve(cwd, source);
  const runLines =
    input === undefined
      ? (environment?.runLines ?? runLocalLines)
      : (
          args: readonly string[],
          root: string,
          handler: (line: string) => void,
          abort?: AbortSignal,
        ) => runLocalLines(args, root, handler, abort, input);
  const result = await runLines(
    arguments_,
    cwd,
    (line) => {
      if (line.length === 0) return;
      const parsed = JSON.parse(line) as { readonly type?: unknown };
      if (parsed.type !== "match") return;
      const event = parsed as RipgrepMatchEvent;
      if (onLine !== undefined) {
        const { path: source, line_number: lineNumber } = event.data;
        if (source.text !== undefined && Number.isSafeInteger(lineNumber))
          onLine(resolveSource(source.text), lineNumber);
      } else matches.push(...matchesFromEvent(event, resolveSource));
    },
    signal,
  );
  signal?.throwIfAborted();
  if (result.code !== 0 && result.code !== 1)
    throw new Error(result.stderr.trim() || "Ripgrep failed.");
  matches.sort(compareMatches);
  return { matches, complete: true };
}

function runLocalLines(
  arguments_: readonly string[],
  cwd: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
  input?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRipgrepExecutable(), arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    const output = createInterface({ input: child.stdout });
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
      try {
        if (parseError === undefined) onLine(line);
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
      if (signal?.aborted) {
        const error = new Error("Search was aborted.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      if (parseError !== undefined) {
        reject(new Error("Unable to parse ripgrep search output.", { cause: parseError }));
        return;
      }
      resolve({ code, stderr });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", (error: Error) => {
      parseError ??= error;
    });
    child.stdin.end(input);
  });
}

function isPcre2MatchLimitError(error: unknown): boolean {
  return (
    error instanceof Error && /PCRE2: error matching: match limit exceeded/iu.test(error.message)
  );
}

function matchesFromEvent(
  event: RipgrepMatchEvent,
  resolveSource: (source: string) => string,
): TextSearchMatch[] {
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
    if (submatch.start < 0 || submatch.end <= submatch.start || submatch.end > lineBuffer.length) {
      continue;
    }

    const startColumn = lineBuffer.subarray(0, submatch.start).toString("utf8").length;
    const endColumn = lineBuffer.subarray(0, submatch.end).toString("utf8").length;
    matches.push({
      source: resolveSource(source),
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
