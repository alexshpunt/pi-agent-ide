import spawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchPluginApi, SearchSelectionMatch } from "pi-agent-search/api/search";

import type { SearchEnvironment, SearchRequest, SearchResolver } from "pi-agent-search/api/search";
import { selectionData, containsSearchMatch } from "pi-agent-search/api/search";
import { verifyResultTargets } from "pi-agent-resource";
import { renderSearchResult } from "pi-agent-search-text/rendering";

import { createAstSearchPresentation } from "./search-presentation.js";

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
  readonly metaVariables?: {
    readonly single: Readonly<Record<string, AstCapture>>;
    readonly multi: Readonly<Record<string, readonly AstCapture[]>>;
  };
}

interface AstCapture {
  readonly text: string;
  readonly range: AstGrepMatch["range"];
}

/** Search AST patterns inside exact source scopes and keep capture authority with each parent. */
export function createAstSearchResolver(
  registerSelection: SearchPluginApi["registerSelection"],
): SearchResolver {
  return {
    id: "ast",
    supportsResultScope: true,
    renderResult: renderSearchResult as SearchResolver["renderResult"],
    async tryResolve(request, context) {
      if (!request.query.startsWith("ast:")) {
        return { kind: "not-handled" };
      }

      const pattern = request.query.slice("ast:".length).trim();

      if (pattern.length === 0) {
        return { kind: "failed", error: new Error("ast: pattern must not be empty") };
      }

      const owner = (source: string): SearchEnvironment | undefined =>
        context.environmentForSource?.(source) ?? context.environment;
      const collect = async (signal?: AbortSignal) => {
        if (context.scope !== undefined) await verifyResultTargets(context.scope, signal);
        const found: AstGrepMatch[] = [];
        if (context.scope === undefined) {
          found.push(
            ...(await runAstGrep(pattern, request, context.cwd, signal, context.environment)),
          );
        } else {
          for (const source of new Set(context.scope.targets.map((target) => target.source))) {
            signal?.throwIfAborted();
            found.push(
              ...(await runAstGrep(
                pattern,
                { ...request, path: source },
                context.cwd,
                signal,
                owner(source),
              )),
            );
          }
        }
        const mapped = found.map((match) => ({
          ...match,
          file: resolveSource(context.cwd, match.file, owner(match.file)),
        }));
        mapped.sort(
          (a, b) =>
            a.file.localeCompare(b.file) ||
            a.range.byteOffset.start - b.range.byteOffset.start ||
            a.range.byteOffset.end - b.range.byteOffset.end,
        );
        const eligible: { raw: AstGrepMatch; selection: SearchSelectionMatch }[] = [];
        for (const match of mapped) {
          const selection = (
            await selectionMatches([match], context.cwd, signal, owner(match.file))
          )[0];
          if (selection === undefined) throw new Error("Missing AST selection snapshot");
          if (context.scope !== undefined && !containsSearchMatch(context.scope, selection))
            continue;
          eligible.push({
            selection,
            raw: {
              ...match,
              range: {
                ...match.range,
                start: { line: selection.lineNumber - 1, column: selection.startColumn },
                end: {
                  line: (selection.endLineNumber ?? selection.lineNumber) - 1,
                  column: selection.endColumn,
                },
              },
            },
          });
        }
        const kept = eligible.slice(0, request.limit ?? 100);
        if (context.scope !== undefined) await verifyResultTargets(context.scope, signal);
        return {
          raw: kept.map((item) => item.raw),
          matches: kept.map((item) => item.selection),
          complete: (context.scope?.complete ?? true) && eligible.length <= (request.limit ?? 100),
        };
      };
      const selected = await collect(context.signal);
      const session = await registerSelection(
        { request, matches: selected.matches, complete: selected.complete, refresh: collect },
        context,
      );
      const data = selectionData(selected.matches, selected.complete, session.id, session);
      const captures: Record<string, ReturnType<typeof selectionData>["matches"]>[] = [];
      for (const raw of selected.raw.slice(0, data.matches.length)) {
        const groups = Object.entries({
          ...Object.fromEntries(
            Object.entries(raw.metaVariables?.single ?? {}).map(([name, node]) => [name, [node]]),
          ),
          ...raw.metaVariables?.multi,
        });
        const projected: [string, ReturnType<typeof selectionData>["matches"]][] = [];
        for (const [name, nodes] of groups) {
          for (const node of nodes) {
            if (
              node.range.byteOffset.start < raw.range.byteOffset.start ||
              node.range.byteOffset.end > raw.range.byteOffset.end
            )
              throw new Error("AST capture lies outside its parent match.");
          }
          const matches = await selectionMatches(
            nodes.map((node) => ({ ...raw, ...node })),
            context.cwd,
            context.signal,
            owner(raw.file),
          );
          const nodesData: ReturnType<typeof selectionData>["matches"] = [];
          for (let offset = 0; offset < matches.length; offset += 100) {
            const chunk = matches.slice(offset, offset + 100);
            const captured = await registerSelection(
              {
                request,
                matches: chunk,
                complete: selected.complete,
                refresh: async () => {
                  throw new Error("Capture snapshots cannot refresh; repeat the AST search.");
                },
              },
              context,
            );
            nodesData.push(...selectionData(chunk, selected.complete, undefined, captured).matches);
          }
          projected.push([name, nodesData]);
        }
        captures.push(Object.fromEntries(projected));
      }
      if (context.scope !== undefined) await verifyResultTargets(context.scope, context.signal);
      return {
        kind: "resolved",
        payload: {
          data: {
            ...data,
            matches: data.matches.map((match, index) => ({ ...match, captures: captures[index] })),
          },
          pattern,
          matches: selected.raw.map((match, index) => ({
            ...match,
            selection: selected.matches[index],
          })),
          complete: selected.complete,
          sessionId: session.id,
          presentation: createAstSearchPresentation(
            request.query,
            selected.raw,
            selected.complete,
            context.cwd,
            session.id,
          ),
        },
      };
    },
    toScriptData(payload) {
      return (payload as { readonly data: unknown }).data;
    },
    format(payload) {
      const result = payload as {
        readonly pattern: string;
        readonly sessionId: string;
        readonly matches: readonly AstGrepMatch[];
        readonly complete: boolean;
        readonly presentation: unknown;
      };

      if (result.matches.length === 0) {
        return {
          content: [{ type: "text", text: "No AST matches found." }],
          details: result.presentation,
        };
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

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result.presentation,
      };
    },
  };
}

async function selectionMatches(
  matches: readonly AstGrepMatch[],
  cwd: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
): Promise<SearchSelectionMatch[]> {
  const sources = new Map<string, Buffer>();
  for (const match of matches) {
    const source = resolveSource(cwd, match.file, environment);
    if (sources.has(source)) continue;
    if (environment !== undefined) {
      sources.set(source, Buffer.from(await environment.readText(source, signal)));
    } else {
      const before = await stat(source);
      const bytes = await readFile(source, { signal });
      const after = await stat(source);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
        throw new Error("AST source changed during search. Run the structural query again.");
      sources.set(source, bytes);
    }
  }
  return matches.map((match) => {
    const source = resolveSource(cwd, match.file, environment);
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
  environment?: SearchEnvironment,
): Promise<AstGrepMatch[]> {
  const arguments_ = ["run", "--pattern", pattern, "--json=compact", "--no-ignore", "parent"];

  for (const include of splitGlobs(request.include)) {
    arguments_.push("--globs", include);
  }

  for (const exclude of splitGlobs(request.exclude)) {
    arguments_.push("--globs", `!${exclude}`);
  }

  if (environment !== undefined) {
    return runOwnedAstGrep(environment, arguments_, request, cwd, signal);
  }
  resolveSource(cwd, request.path ?? ".");
  arguments_.push(request.path ?? ".");
  return new Promise((resolve, reject) => {
    const child = spawn("ast-grep", arguments_, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
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

function resolveSource(cwd: string, source: string, environment?: SearchEnvironment): string {
  if (environment !== undefined) return environment.resolve(cwd, source);
  if (source.includes("://") || cwd.includes("://"))
    throw new Error("No structural search owner for this resource.");
  return path.resolve(cwd, source);
}

async function runOwnedAstGrep(
  environment: SearchEnvironment,
  arguments_: string[],
  request: SearchRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<AstGrepMatch[]> {
  if (environment.execute === undefined)
    throw new Error("This resource owner does not support structural search execution.");
  const scope = environment.resolve(cwd, request.path ?? ".");
  const directory = await environment.isDirectory(scope, signal);
  const executionCwd = directory ? scope : environment.dirname(scope);
  arguments_.push(directory ? "." : `./${environment.basename(scope)}`);
  const result = await environment.execute("ast-grep", arguments_, executionCwd, signal);
  signal?.throwIfAborted();
  if (result.code !== 0 && result.code !== 1)
    throw new Error(`Structural search failed with exit ${String(result.code)}.`);
  const value: unknown = JSON.parse(result.stdout.length === 0 ? "[]" : result.stdout);
  if (!Array.isArray(value)) throw new TypeError("ast-grep returned non-array JSON");
  return (value as AstGrepMatch[]).map((match) => ({
    ...match,
    file: environment.resolve(executionCwd, match.file),
  }));
}
function splitGlobs(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
