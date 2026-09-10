import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchPluginApi, SearchSelectionMatch } from "pi-agent-search/api/search";

import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";

interface AstGrepMatch {
  readonly text: string;
  readonly file: string;
  readonly lines: string;
  readonly language: string;
  readonly range: {
    readonly byteOffset: { readonly start: number; readonly end: number };
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly metaVariables?: unknown;
}

export function createAstSearchResolver(
  registerSelection: SearchPluginApi["registerSelection"],
): SearchResolver {
  return {
    id: "ast",
    async tryResolve(request, context) {
      if (!request.query.startsWith("ast:")) {
        return { kind: "not-handled" };
      }

      const pattern = request.query.slice("ast:".length).trim();

      if (pattern.length === 0) {
        return { kind: "failed", error: new Error("ast: pattern must not be empty") };
      }

      const collect = async (signal?: AbortSignal) => {
        const started = Date.now();
        const found = await runAstGrep(pattern, request, context.cwd, signal);
        found.sort(
          (a, b) =>
            path.resolve(context.cwd, a.file).localeCompare(path.resolve(context.cwd, b.file)) ||
            a.range.byteOffset.start - b.range.byteOffset.start ||
            a.range.byteOffset.end - b.range.byteOffset.end,
        );
        const raw = found.slice(0, request.limit ?? 100);
        return {
          raw,
          matches: await selectionMatches(raw, context.cwd, started, signal),
          complete: found.length <= (request.limit ?? 100),
        };
      };
      const selected = await collect(context.signal);
      const session = await registerSelection(
        { request, matches: selected.matches, complete: selected.complete, refresh: collect },
        context,
      );
      return {
        kind: "resolved",
        payload: {
          pattern,
          matches: selected.raw,
          complete: selected.complete,
          sessionId: session.id,
        },
      };
    },
    format(payload) {
      const result = payload as {
        readonly pattern: string;
        readonly sessionId: string;
        readonly matches: readonly AstGrepMatch[];
        readonly complete: boolean;
      };

      if (result.matches.length === 0) {
        return { content: [{ type: "text", text: "No AST matches found." }], details: result };
      }

      const lines = result.matches.flatMap((match, index) => [
        `SEARCH#${result.sessionId}:${String(index + 1)}:match ${match.file}:${String(match.range.start.line + 1)}:${String(
          match.range.start.column + 1,
        )} ${match.language}`,
        `   ${match.lines.trim()}`,
      ]);

      if (result.complete)
        lines.unshift(`SEARCH#${result.sessionId}:all:match selects all exact AST matches.`);
      if (!result.complete) {
        lines.push("Result limit reached.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  };
}

async function selectionMatches(
  matches: readonly AstGrepMatch[],
  cwd: string,
  started: number,
  signal?: AbortSignal,
): Promise<SearchSelectionMatch[]> {
  const sources = new Map<string, Buffer>();
  for (const match of matches) {
    const source = path.resolve(cwd, match.file);
    if (sources.has(source)) continue;
    const before = await stat(source);
    const bytes = await readFile(source, { signal });
    const after = await stat(source);
    if (before.mtimeMs > started || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
      throw new Error("AST source changed during search. Run the structural query again.");
    sources.set(source, bytes);
  }
  return matches.map((match) => {
    const source = path.resolve(cwd, match.file);
    const bytes = sources.get(source);
    if (bytes === undefined) throw new Error("Missing AST source snapshot");
    const { start, end } = match.range.byteOffset;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > bytes.length ||
      bytes.subarray(start, end).toString("utf8") !== match.text
    )
      throw new Error("AST range does not match its source snapshot. Search again.");
    const prefix = bytes.subarray(0, start).toString("utf8");
    const throughEnd = bytes.subarray(0, end).toString("utf8");
    const lineNumber = prefix.split("\n").length;
    return {
      source,
      lineNumber,
      endLineNumber: throughEnd.split("\n").length,
      startColumn: prefix.length - prefix.lastIndexOf("\n") - 1,
      endColumn: throughEnd.length - throughEnd.lastIndexOf("\n") - 1,
      matchedText: match.text,
      lineText: bytes.toString("utf8").split("\n")[lineNumber - 1]?.replace(/\r$/u, "") ?? "",
    };
  });
}
function runAstGrep(
  pattern: string,
  request: SearchRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<AstGrepMatch[]> {
  const arguments_ = ["run", "--pattern", pattern, "--json=compact", "--no-ignore", "parent"];

  for (const include of splitGlobs(request.include)) {
    arguments_.push("--globs", include);
  }

  for (const exclude of splitGlobs(request.exclude)) {
    arguments_.push("--globs", `!${exclude}`);
  }

  arguments_.push(request.path ?? ".");
  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);

      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("AST search aborted"));
        return;
      }

      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `ast-grep exited with code ${String(code)}`));
        return;
      }

      try {
        const value: unknown = JSON.parse(stdout.length === 0 ? "[]" : stdout);

        if (!Array.isArray(value)) {
          throw new TypeError("ast-grep returned non-array JSON");
        }

        resolve(value as AstGrepMatch[]);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function splitGlobs(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
