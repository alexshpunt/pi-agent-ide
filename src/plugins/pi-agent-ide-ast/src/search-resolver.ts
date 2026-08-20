import { spawn } from "node:child_process";

import type { SearchRequest, SearchResolver } from "pi-agent-search/api/search";

interface AstGrepMatch {
  readonly text: string;
  readonly file: string;
  readonly lines: string;
  readonly language: string;
  readonly range: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly metaVariables?: unknown;
}

export function createAstSearchResolver(): SearchResolver {
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

      const matches = await runAstGrep(pattern, request, context.cwd, context.signal);
      const limit = request.limit ?? 100;
      return {
        kind: "resolved",
        payload: { pattern, matches: matches.slice(0, limit), complete: matches.length <= limit },
      };
    },
    format(payload) {
      const result = payload as {
        readonly pattern: string;
        readonly matches: readonly AstGrepMatch[];
        readonly complete: boolean;
      };

      if (result.matches.length === 0) {
        return { content: [{ type: "text", text: "No AST matches found." }], details: result };
      }

      const lines = result.matches.flatMap((match, index) => [
        `${String(index + 1)}. ${match.file}:${String(match.range.start.line + 1)}:${String(
          match.range.start.column + 1,
        )} ${match.language}`,
        `   ${match.lines.trim()}`,
      ]);

      if (!result.complete) {
        lines.push("Result limit reached.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: result };
    },
  };
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
