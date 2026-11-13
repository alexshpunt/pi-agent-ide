import spawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import type { SearchPluginApi, SearchSelectionMatch } from "pi-agent-search/api/search";

import type { SearchEnvironment, SearchRequest, SearchResolver } from "pi-agent-search/api/search";
import {
  selectionData,
  containsSearchMatch,
  currentScope,
  splitGlobList,
} from "pi-agent-search/api/search";
import {
  readUnchanged,
  verifyResultTargets,
  type FileGenerationReader,
  type ResolvedResultTargets,
  type ResultSourceTarget,
} from "pi-agent-resource";
import { renderSearchResult } from "pi-agent-search-text/rendering";

import { localAstGrepCommand } from "./ast-grep-binary.ts";
import { createAstSearchPresentation } from "./search-presentation.ts";

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

/** Options the `ast_search` tool passes in `SearchRequest.options.ast`; their presence selects this resolver. */
export interface AstSearchOptions {
  readonly pattern?: string;
  /** An ast-grep rule object (the value of `rule:` in a rule file); requires `language`. */
  readonly rule?: Readonly<Record<string, unknown>>;
  readonly language?: string;
  /** `inside` keeps matches within the scope ranges; `enclosing` keeps the innermost match containing each range. */
  readonly relation?: "inside" | "enclosing";
}

function astOptions(request: SearchRequest): AstSearchOptions | undefined {
  const value = request.options?.ast;
  return typeof value === "object" && value !== null ? value : undefined;
}

interface Position {
  readonly line: number;
  readonly column: number;
}
const before = (a: Position, b: Position) =>
  a.line < b.line || (a.line === b.line && a.column <= b.column);

/** For each scope range, keep the smallest match that wholly contains it, once per match. */
function innermostEnclosing<T extends { readonly selection: SearchSelectionMatch }>(
  eligible: readonly T[],
  targets: ResolvedResultTargets["targets"],
): T[] {
  const chosen = new Set<T>();
  for (const target of targets) {
    for (const range of target.ranges) {
      const start = { line: range.start.lineNumber, column: range.start.column };
      const end = { line: range.end.lineNumber, column: range.end.column };
      let best: T | undefined;
      let bestLength = Number.POSITIVE_INFINITY;
      for (const item of eligible) {
        const match = item.selection;
        if (match.source !== target.source) continue;
        const matchStart = { line: match.lineNumber, column: match.startColumn };
        const matchEnd = { line: match.endLineNumber ?? match.lineNumber, column: match.endColumn };
        if (!before(matchStart, start) || !before(end, matchEnd)) continue;
        if (match.matchedText.length < bestLength) {
          best = item;
          bestLength = match.matchedText.length;
        }
      }
      if (best !== undefined) chosen.add(best);
    }
  }
  return eligible.filter((item) => chosen.has(item));
}

/** Search existing AST patterns inside exact source scopes and retain associated capture targets. */
export function createAstSearchResolver(
  registerSelection: SearchPluginApi["registerSelection"],
): SearchResolver {
  return {
    id: "ast",
    supportsResultScope: true,
    supportsPathList: true,
    readResources: (request, context) =>
      astOptions(request) === undefined
        ? []
        : (context.scope?.targets.map((target) => target.source) ??
          request.paths ?? [request.path ?? context.cwd]),
    renderResult: renderSearchResult as SearchResolver["renderResult"],
    async tryResolve(request, context) {
      const options = astOptions(request);
      if (options === undefined) return { kind: "not-handled" };

      const pattern = options.pattern?.trim() ?? "";
      const enclosing = options.relation === "enclosing";

      if (pattern.length === 0 && options.rule === undefined) {
        return { kind: "failed", error: new Error("Pass a pattern or a rule.") };
      }
      if (options.rule !== undefined && (options.language ?? "").trim().length === 0) {
        return { kind: "failed", error: new Error("A rule requires language.") };
      }
      if (enclosing && context.scope === undefined) {
        return {
          kind: "failed",
          error: new Error(
            'relation "enclosing" needs a Read, Search or edit result as path; it returns the innermost match containing each of its ranges.',
          ),
        };
      }

      const owner = (source: string): SearchEnvironment | undefined =>
        context.environmentForSource?.(source) ?? context.environment;
      // Bytes ast-grep parsed, by file, so results and captures map onto the same text even
      // when another process writes the file meanwhile.
      let snapshots = new Map<string, Buffer>();
      // The same bytes as text, converted once per file: every anchor of this search registers
      // from the text its matches were found in, with no second read another writer could change.
      let snapshotTexts = new Map<string, string>();
      const searchedText = (matches: readonly SearchSelectionMatch[]) => {
        const contents = new Map<string, string>();
        for (const match of matches) {
          if (contents.has(match.source)) continue;
          let text = snapshotTexts.get(match.source);
          if (text === undefined) {
            const bytes = snapshots.get(match.source);
            if (bytes === undefined) continue;
            text = bytes.toString("utf8");
            snapshotTexts.set(match.source, text);
          }
          contents.set(match.source, text);
        }
        return contents;
      };
      // A scope is searched as the text it holds: its ranges are positions in that text, and a
      // file other sessions keep writing has moved on by the time ast-grep would read it.
      const search = async (
        searched: SearchRequest,
        signal?: AbortSignal,
        scoped?: ResultSourceTarget,
      ) => {
        const environment = owner(searched.path ?? ".");
        const snapshot =
          environment === undefined
            ? await runAstGrepOnSnapshot(pattern, searched, context.cwd, signal, scoped)
            : undefined;
        if (snapshot === undefined) {
          const matches = await runAstGrep(pattern, searched, context.cwd, signal, environment);
          // ast-grep read the file itself, so the scope must still describe it.
          if (scoped !== undefined)
            await verifyResultTargets({ targets: [scoped], complete: true }, signal);
          return matches;
        }
        snapshots.set(snapshot.source, snapshot.bytes);
        return snapshot.matches;
      };
      // The first attempt uses the scope as resolved; a retry resolves it again.
      let scope = context.scope;
      const collect = async (signal?: AbortSignal, again = true) => {
        snapshots = new Map();
        snapshotTexts = new Map();
        if (again && scope !== undefined) scope = await currentScope(context, signal);
        const found: AstGrepMatch[] = [];
        if (scope === undefined && request.paths !== undefined) {
          // Each listed path is searched on its own; a file found under an earlier one counts once.
          const searched = new Set<string>();
          for (const root of request.paths) {
            signal?.throwIfAborted();
            const files = new Set<string>();
            const read = new Set(snapshots.keys());
            for (const match of await search(
              { ...request, paths: undefined, path: root },
              signal,
            )) {
              const file = resolveSource(context.cwd, match.file, owner(match.file));
              if (searched.has(file)) {
                // The earlier path's matches keep the text ast-grep read for them.
                if (!read.has(file)) snapshots.delete(file);
                continue;
              }
              files.add(file);
              found.push(match);
            }
            for (const file of files) searched.add(file);
          }
        } else if (scope === undefined) {
          found.push(...(await search(request, signal)));
        } else {
          for (const scoped of scope.targets) {
            signal?.throwIfAborted();
            found.push(...(await search({ ...request, path: scoped.source }, signal, scoped)));
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
            await selectionMatches([match], context.cwd, signal, owner(match.file), snapshots)
          )[0];
          if (selection === undefined) throw new Error("Missing AST selection snapshot");
          if (!enclosing && scope !== undefined && !containsSearchMatch(scope, selection)) continue;
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
        const candidates =
          enclosing && scope !== undefined ? innermostEnclosing(eligible, scope.targets) : eligible;
        const kept = candidates.slice(0, request.limit ?? 100);
        // The search session keeps this result and its refresh closure for as long as its anchors
        // live. A copy keeps only the matched text, not each file the text was cut from.
        const result = structuredClone({
          raw: kept.map((item) => item.raw),
          matches: kept.map((item) => item.selection),
          complete: (scope?.complete ?? true) && candidates.length <= (request.limit ?? 100),
        });
        // The text the matches were found in, so registering their anchors and a later refresh
        // need no second read that another writer could change in between. It is used once and
        // not retained.
        return { ...result, contents: searchedText(result.matches) };
      };
      // Anchors register only while the file still has the searched text; another process may
      // write it in between, so search again, with the scope resolved against the new text.
      let attempts = 0;
      const register = async (selection: Parameters<typeof registerSelection>[0]) => {
        try {
          // Every selection of this search, matches and captures alike, registers from the text
          // ast-grep parsed. A second read here would see what another writer did meanwhile.
          return await registerSelection(
            { contents: searchedText(selection.matches), ...selection },
            context,
          );
        } catch (error) {
          if (error instanceof Error && error.name === "SearchSnapshotChangedError")
            throw sourceChanged(error.message);
          throw error;
        }
      };
      const { selected, session, data, captures, captureGroups } = await collectWhileSourceChanges(
        async () => {
          const selected = await collect(context.signal, attempts++ > 0);
          const session = await register({
            request,
            matches: selected.matches,
            complete: selected.complete,
            refresh: collect,
          });
          const data = selectionData(selected.matches, selected.complete, session.id, session);
          const captures: Record<string, ReturnType<typeof selectionData>["matches"]>[] = [];
          const captureGroups: Record<string, { target: string; nodes: number }>[] = [];
          for (const raw of selected.raw.slice(0, data.matches.length)) {
            const groups = Object.entries({
              ...Object.fromEntries(
                Object.entries(raw.metaVariables?.single ?? {}).map(([name, node]) => [
                  name,
                  [node],
                ]),
              ),
              // `scan` reports relational rule labels as a `secondary` group; they are not captures.
              ...Object.fromEntries(
                Object.entries(raw.metaVariables?.multi ?? {}).filter(
                  ([name]) => name !== "secondary",
                ),
              ),
            });
            const projected = [];
            const groupsForMatch: Record<string, { target: string; nodes: number }> = {};
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
                snapshots,
              );
              const group = await register({
                request,
                matches,
                complete: selected.complete,
                refresh: async () => {
                  throw new Error("Capture snapshots cannot refresh; repeat the AST search.");
                },
              });
              const captured = selectionData(matches, selected.complete, undefined, group);
              groupsForMatch[name] = {
                target: requiredValue(captured.target),
                nodes: matches.length,
              };
              projected.push([name, captured.matches] as const);
            }
            captures.push(Object.fromEntries(projected));
            captureGroups.push(groupsForMatch);
          }
          return { selected, session, data, captures, captureGroups };
        },
        context.signal,
      );
      return {
        kind: "resolved",
        payload: {
          data: {
            ...data,
            matches: data.matches.map((match, index) => ({ ...match, captures: captures[index] })),
          },
          captureGroups,
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
        readonly data: {
          matches: { captures?: Record<string, ReturnType<typeof selectionData>["matches"]> }[];
        };
        readonly pattern: string;
        readonly captureGroups: Record<string, { target: string; nodes: number }>[];
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

      const lines = result.matches.flatMap((match, index) => {
        const rows = [
          `SEARCH#${result.sessionId}:${index + 1}:match ${match.file}:${match.range.start.line + 1}:${match.range.start.column + 1} ${match.language}`,
          `   ${match.lines.trim()}`,
        ];
        for (const [name, group] of Object.entries(result.captureGroups[index] ?? {})) {
          rows.push(`   capture ${name}: ${group.target} ${group.nodes} node(s)`);
        }
        return rows;
      });

      if (result.complete)
        lines.unshift(`SEARCH#${result.sessionId}:all:match selects all exact AST matches.`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result.presentation,
      };
    },
  };
}

/**
 * Maps ast-grep byte ranges onto lines and UTF-16 columns of the bytes it searched. A file this
 * reads itself is added to `snapshots`, so one search reads each file once and every match of
 * it describes the same text.
 */
async function selectionMatches(
  matches: readonly AstGrepMatch[],
  cwd: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
  snapshots?: Map<string, Buffer>,
): Promise<SearchSelectionMatch[]> {
  const sources = new Map<string, Buffer>();
  for (const match of matches) {
    const source = resolveSource(cwd, match.file, environment);
    if (sources.has(source)) continue;
    const snapshot = snapshots?.get(source);
    if (snapshot !== undefined) {
      sources.set(source, snapshot);
      continue;
    }
    let bytes: Buffer;
    if (environment !== undefined) {
      bytes = Buffer.from(await environment.readText(source, signal));
    } else {
      bytes = await readSearchedSource(source, signal);
    }
    sources.set(source, bytes);
    snapshots?.set(source, bytes);
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
      throw sourceChanged("AST range does not match its source snapshot. Search again.");
    const starts = lineStarts(bytes);
    const startLine = lineIndexAt(starts, start);
    const endLine = lineIndexAt(starts, end);
    const lineStart = requiredValue(starts[startLine]);
    const nextLine = starts[startLine + 1];
    return {
      source,
      lineNumber: startLine + 1,
      endLineNumber: endLine + 1,
      startColumn: bytes.subarray(lineStart, start).toString("utf8").length,
      endColumn: bytes.subarray(requiredValue(starts[endLine]), end).toString("utf8").length,
      matchedText: match.text,
      lineText: bytes
        .subarray(lineStart, nextLine === undefined ? bytes.length : nextLine - 1)
        .toString("utf8")
        .replace(/\r$/u, ""),
    };
  });
}

/**
 * The bytes of a searched file, read so that a write during the read is noticed even when the
 * filesystem timestamps cannot tell. `fileGeneration` is for tests, which supply coarse timestamps.
 */
export async function readSearchedSource(
  source: string,
  signal?: AbortSignal,
  fileGeneration?: FileGenerationReader,
): Promise<Buffer> {
  const read = await readUnchanged(
    source,
    () => readFile(source, { signal }),
    (first, second) => first.equals(second),
    fileGeneration,
  );
  if (read === undefined)
    throw sourceChanged("AST source changed during search. Run the structural query again.");
  return read.value;
}

/** Byte offsets where each line of a searched file starts, computed once per snapshot. */
const lineStartsBySnapshot = new WeakMap<Buffer, readonly number[]>();

function lineStarts(bytes: Buffer): readonly number[] {
  let starts = lineStartsBySnapshot.get(bytes);
  if (starts === undefined) {
    const found = [0];
    for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1))
      found.push(index + 1);
    starts = found;
    lineStartsBySnapshot.set(bytes, starts);
  }
  return starts;
}

/** Zero-based line that contains the byte at `offset`. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (requiredValue(starts[middle]) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
function runAstGrep(
  pattern: string,
  request: SearchRequest,
  cwd: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
): Promise<AstGrepMatch[]> {
  signal?.throwIfAborted();
  const { rule, language } = astOptions(request) ?? {};
  // A rule runs through `scan` with one inline rule; JSON is valid YAML for ast-grep.
  const arguments_ =
    rule === undefined
      ? ["run", "--pattern", pattern, "--json=compact", "--no-ignore", "parent"]
      : [
          "scan",
          "--inline-rules",
          JSON.stringify({ id: "ast_search", language, severity: "hint", rule }),
          "--json=compact",
          "--no-ignore",
          "parent",
        ];

  for (const include of splitGlobList(request.include)) {
    arguments_.push("--globs", include);
  }

  for (const exclude of splitGlobList(request.exclude)) {
    arguments_.push("--globs", `!${exclude}`);
  }

  if (environment !== undefined) {
    return runOwnedAstGrep(environment, arguments_, request, cwd, signal);
  }
  resolveSource(cwd, request.path ?? ".");
  arguments_.push(request.path ?? ".");
  return new Promise((resolve, reject) => {
    const child = spawn(localAstGrepCommand(), arguments_, {
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

/** Searches of one pattern while other processes keep writing its files. */
const SOURCE_CHANGE_DELAYS_MS = [0, 100, 250, 500];

function sourceChanged(message: string): Error {
  return Object.assign(new Error(message), { code: "SOURCE_CHANGED" });
}

/**
 * Another Pi process may write a file between ast-grep's parse and this snapshot. Retries are
 * bounded; a file that keeps changing fails with what changed and how many runs it took.
 */
async function collectWhileSourceChanges<T>(
  collect: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await collect();
    } catch (error) {
      const delay = SOURCE_CHANGE_DELAYS_MS[attempt];
      const changed = (error as { code?: unknown } | null)?.code === "SOURCE_CHANGED";
      if (!changed || signal?.aborted) throw error;
      if (delay === undefined)
        throw sourceChanged(
          `${error instanceof Error ? error.message : String(error)} The structural search ran ${String(attempt + 1)} times and another process wrote its files during every run. Repeat it when those writes stop.`,
        );
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Searches one local file through ast-grep's standard input, with the bytes read here, or the
 * text of its scope when it has one. Returns
 * undefined when the path is not one file or ast-grep cannot take the language from the request
 * or the file extension; the caller then lets ast-grep read the path.
 */
async function runAstGrepOnSnapshot(
  pattern: string,
  request: SearchRequest,
  cwd: string,
  signal: AbortSignal | undefined,
  scoped?: ResultSourceTarget,
): Promise<{ source: string; bytes: Buffer; matches: AstGrepMatch[] } | undefined> {
  // Globs filter files by path, which standard input does not have.
  if (
    request.path === undefined ||
    request.path.includes("://") ||
    cwd.includes("://") ||
    request.include !== undefined ||
    request.exclude !== undefined
  )
    return undefined;
  const source = path.resolve(cwd, request.path);
  const isFile =
    scoped !== undefined ||
    (await stat(source).then(
      (info) => info.isFile(),
      () => false,
    ));
  if (!isFile) return undefined;
  const { rule, language } = astOptions(request) ?? {};
  const lang = language ?? path.extname(source).slice(1);
  if (lang.length === 0) return undefined;
  // A scope holds the text its ranges describe; any other path is read now.
  const bytes =
    scoped === undefined ? await readFile(source, { signal }) : Buffer.from(scoped.expectedContent);
  const arguments_ =
    rule === undefined
      ? ["run", "--pattern", pattern, "--lang", lang, "--stdin", "--json=compact"]
      : [
          "scan",
          "--inline-rules",
          JSON.stringify({ id: "ast_search", language, severity: "hint", rule }),
          "--stdin",
          "--json=compact",
        ];
  const result = await spawnAstGrep(arguments_, cwd, signal, bytes);
  if (result === undefined) return undefined;
  return { source, bytes, matches: result.map((match) => ({ ...match, file: source })) };
}

/** Runs ast-grep on standard input; undefined when it fails, such as for an unknown language. */
function spawnAstGrep(
  arguments_: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  input: Buffer,
): Promise<AstGrepMatch[] | undefined> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(localAstGrepCommand(), [...arguments_], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("AST search aborted"));
        return;
      }
      if (code !== 0 && code !== 1) {
        resolve(undefined);
        return;
      }
      try {
        const value: unknown = JSON.parse(stdout.length === 0 ? "[]" : stdout);
        resolve(Array.isArray(value) ? (value as AstGrepMatch[]) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}
