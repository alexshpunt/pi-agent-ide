import { requiredValue } from "pi-agent-invariant";
import type { ResultTargetStore, ResolvedResultTargets } from "pi-agent-resource";
import type {
  SearchSelectionMatch,
  SearchSelectionRegistration,
  SearchContext,
} from "pi-agent-search/api/search";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchEnvironment } from "pi-agent-search/api/search";

import {
  createTextDocument,
  type TextAnchorResolutionAttempt,
  type TextAnchorResolver,
  type TextTarget,
  type TextTargetResolutionAttempt,
} from "pi-agent-text";
import {
  TextSelectionAnchor,
  type TextSelectionRange,
} from "pi-agent-text-editor/api/text-selection-anchor";

import type { TextAnchorResourceResolver } from "pi-agent-text-editor/api/plugin-protocol";
import { runSearchRecipe, type SearchRecipe } from "#src/search-recipe.js";

const searchAnchorPattern = /^SEARCH#([A-F0-9]{4,64}):(all|[1-9]\d*):(line|match)$/u;
const minimumSearchSessionIdLength = 4;

export type TextSearchMatch = SearchSelectionMatch;

export interface TextSearchSession {
  readonly id: string;
  readonly query: string;
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  /** Strict source handles stay separate from legacy refreshing SEARCH references. */
  readonly target?: string;
  readonly matchTargets?: readonly string[];
}

interface SearchSnapshot {
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  readonly contentBySource: ReadonlyMap<string, string>;
}

type SnapshotReader = (source: string, signal?: AbortSignal) => Promise<string>;

interface StoredSearchSession extends TextSearchSession, SearchSnapshot {
  readonly read?: SnapshotReader;
  readonly environment?: SearchEnvironment;
  readonly refresh?: SearchSelectionRegistration["refresh"];
  readonly recipe: SearchRecipe;
  readonly snapshotByteBudget?: number;
  readonly cwd: string;
  readonly refreshedComplete?: SearchSnapshot;
}

interface ParsedSearchAnchor {
  readonly id: string;
  readonly selector: "all" | number;
  readonly mode: "line" | "match";
}

/** Creates the default display ID for a search outside a session store. */
export function createSearchSessionId(
  query: string,
  matches: readonly TextSearchMatch[],
  cwd?: string,
  recipe?: SearchRecipe,
): string {
  return createSearchSessionIdentity(query, matches, cwd, recipe).slice(
    0,
    minimumSearchSessionIdLength,
  );
}

/** Creates the complete stable identity from a search recipe and its matches. */
export function createSearchSessionIdentity(
  query: string,
  matches: readonly TextSearchMatch[],
  cwd?: string,
  recipe?: SearchRecipe,
): string {
  const root =
    cwd === undefined
      ? commonSourceDirectory(matches.map((match) => match.source))
      : canonicalSource(cwd);
  const identity = matches
    .map((match) => ({
      match,
      source: match.source.includes("://")
        ? canonicalSource(match.source)
        : path.relative(root, path.resolve(match.source)),
    }))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) || compareMatches(left.match, right.match),
    )
    .map(({ match, source }) => [
      source,
      match.lineNumber,
      match.startColumn,
      match.endLineNumber ?? match.lineNumber,
      match.endColumn,
      match.matchedText,
      match.lineText,
    ]);
  const { limit: _detailBudget, ...selectionRecipe } = normalizeRecipe(
    recipe ?? { query, regex: true },
    root,
  );
  return createHash("sha256")
    .update(JSON.stringify([query, root, selectionRecipe, identity]))
    .digest("hex")
    .toUpperCase();
}

/** Returns the shortest unused prefix of a complete search identity. */
export function allocateSearchSessionId(
  identity: string,
  allocatedIds: ReadonlySet<string>,
): string {
  if (!/^[A-F0-9]{64}$/u.test(identity)) {
    throw new Error("Search session identity must be a 64-character uppercase hexadecimal value.");
  }

  for (let length = minimumSearchSessionIdLength; length <= identity.length; length += 1) {
    const candidate = identity.slice(0, length);
    if (!allocatedIds.has(candidate)) return candidate;
  }

  throw new Error("Could not allocate a unique search session id.");
}

function normalizeRecipe(recipe: SearchRecipe, cwd: string): Record<string, unknown> {
  return {
    query: recipe.query,
    path: resolveScope(cwd, recipe.path ?? "."),
    include: recipe.include ?? "",
    exclude: recipe.exclude ?? "",
    caseSensitive: recipe.caseSensitive === true,
    wholeWord: recipe.wholeWord === true,
    limit: recipe.limit ?? 50,
    regex: recipe.regex === true,
    condition: recipe.condition,
    fallbacks: recipe.fallbacks ?? [],
  };
}

/** Indicates that search output is still displayable, but no stable anchors can be registered. */
export class SearchSnapshotChangedError extends Error {
  public constructor(source: string) {
    super(`Search result in ${source} changed before its anchors were registered.`);
    this.name = "SearchSnapshotChangedError";
  }
}

/** Stores search snapshots and resolves the stable anchors emitted for them. */
export class SearchSessionStore {
  readonly #sessions = new Map<string, StoredSearchSession>();
  readonly #idsByIdentity = new Map<string, string>();

  public constructor(
    private readonly createIdentity: typeof createSearchSessionIdentity = createSearchSessionIdentity,
    private readonly resultTargets?: ResultTargetStore,
    private readonly readSource?: (
      source: string,
      cwd: string,
      signal?: AbortSignal,
    ) => Promise<string>,
  ) {}

  /** Capture current files; an optional byte budget also bounds reads if a file grows during capture. */
  public async register(
    query: string,
    sourceMatches: readonly TextSearchMatch[],
    complete: boolean,
    cwd: string,
    signal?: AbortSignal,
    recipe: SearchRecipe = {
      query,
      regex: true,
    },
    refresh?: SearchSelectionRegistration["refresh"],
    snapshotByteBudget?: number,
    environment?: SearchEnvironment,
  ): Promise<TextSearchSession> {
    const matches = sourceMatches
      .map((match) => ({ ...match, source: canonicalSource(match.source) }))
      .sort(compareMatches);
    const readSource = this.readSource;
    const read: SnapshotReader | undefined =
      readSource === undefined ? undefined : (source, abort) => readSource(source, cwd, abort);
    const contentBySource = await snapshotContents(
      matches,
      signal,
      snapshotByteBudget,
      environment,
      read,
    );
    const identity = this.createIdentity(query, matches, cwd, recipe);
    const knownId = this.#idsByIdentity.get(identity);
    const id = knownId ?? allocateSearchSessionId(identity, new Set<string>(this.#sessions.keys()));
    const session: StoredSearchSession = {
      id,
      query,
      matches,
      complete,
      contentBySource,
      read,
      ...registerResultReferences(
        this.resultTargets,
        id,
        matches,
        contentBySource,
        cwd,
        complete,
        (source, abort) => readOwnedText(source, abort, environment, read),
      ),
      ...(snapshotByteBudget === undefined ? {} : { snapshotByteBudget }),
      recipe,
      environment,
      ...(refresh !== undefined && { refresh }),
      cwd: canonicalSource(cwd),
    };
    this.#idsByIdentity.set(identity, id);
    this.#sessions.set(id, session);
    return session;
  }

  /** Registers anchors when every match still describes the current files. */
  public async registerIfCurrent(
    query: string,
    sourceMatches: readonly TextSearchMatch[],
    complete: boolean,
    cwd: string,
    signal?: AbortSignal,
    recipe?: SearchRecipe,
    refresh?: SearchSelectionRegistration["refresh"],
    snapshotByteBudget?: number,
    environment?: SearchEnvironment,
  ): Promise<TextSearchSession | undefined> {
    try {
      return await this.register(
        query,
        sourceMatches,
        complete,
        cwd,
        signal,
        recipe,
        refresh,
        snapshotByteBudget,
        environment,
      );
    } catch (error) {
      if (error instanceof SearchSnapshotChangedError) return undefined;
      throw error;
    }
  }

  /** Repeats each referenced search once, keeping its original scope, limits and fallback rules. */
  public async observeAfterEdit(
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<
    readonly {
      sessionId: string;
      query: string;
      scope: Record<string, unknown>;
      matches?: number;
      complete?: boolean;
      notices?: readonly string[];
      error?: string;
    }[]
  > {
    const ids = new Set(
      values.flatMap((value) => {
        const anchor = typeof value === "string" ? parseSearchAnchor(value) : undefined;
        return anchor === undefined ? [] : [anchor.id];
      }),
    );
    const observations = [];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      if (session === undefined) continue;
      const base = {
        sessionId: id,
        query: session.recipe.originalQuery ?? session.query,
        scope: normalizeRecipe(session.recipe, session.cwd),
      };
      try {
        const result =
          session.refresh === undefined
            ? await runSearchRecipe(session.recipe, session.cwd, signal, session.environment)
            : await session.refresh(signal);
        observations.push({
          ...base,
          matches: result.matches.length,
          complete: result.complete,
          notices: result.notices,
        });
      } catch (error) {
        observations.push({
          ...base,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return observations;
  }

  public anchorResolver(): TextAnchorResolver {
    return {
      id: "search",
      description: [
        "`SEARCH#HASH:N:line` selects one result's full line; `SEARCH#HASH:N:match` selects its exact match.",
        "`SEARCH#HASH:all:line` selects each unique containing line; `SEARCH#HASH:all:match` selects every exact match.",
        "Omit `path` when `all` spans files.",
      ].join("\n"),
      renderFull(value) {
        return value;
      },
      renderCompact(value) {
        const anchor = parseSearchAnchor(value);
        if (anchor === undefined) {
          return "selected result";
        }
        if (anchor.selector === "all") {
          return anchor.mode === "match" ? "all matches" : "all lines";
        }
        return anchor.mode === "match"
          ? `match ${String(anchor.selector)}`
          : `line ${String(anchor.selector)}`;
      },
      tryResolve: (value, context) => this.#resolveAnchor(value, context.source, context.signal),
    };
  }

  /** Resolve Search input with the same numbered-snapshot and all-query refresh authority as edits. */
  public async resolveSearchScope(
    value: string,
    context: SearchContext,
  ): Promise<ResolvedResultTargets | undefined> {
    if (!value.startsWith("SEARCH#")) return undefined;
    const result = await this.#resolveResources(value, context.cwd, context.signal, true);
    if (result.kind !== "resolved")
      throw new Error(
        result.kind === "rejected" ? result.rejection.reason : "Invalid Search reference.",
      );
    const parsed = requiredValue(parseSearchAnchor(value));
    const session = requiredValue(this.#sessions.get(parsed.id));
    return {
      complete: true,
      targets: result.targets.map((target) => {
        if (target.expectedContent === undefined)
          throw new Error("Search snapshot is unavailable.");
        return {
          source: target.source,
          expectedContent: target.expectedContent,
          ranges: target.ranges ?? [],
          readCurrent: async (signal?: AbortSignal) => {
            const current = await readCurrent(
              target.source,
              signal,
              session.environment,
              session.read,
            );
            if (current === undefined) throw new Error("Search source is unavailable.");
            return current;
          },
        };
      }),
    };
  }
  public resourceResolver(): TextAnchorResourceResolver {
    return {
      id: "search-targets",
      tryResolve: (value, context) => this.#resolveResources(value, context.cwd),
    };
  }

  async #resolveAnchor(
    value: string,
    contextSource: string,
    signal?: AbortSignal,
  ): Promise<TextAnchorResolutionAttempt> {
    const parsed = parseSearchAnchor(value);
    if (parsed === undefined) return { kind: "not-handled" };
    let session = this.#sessions.get(parsed.id);
    if (session === undefined) return staleAnchor();
    if (parsed.selector === "all" && !session.complete) return missingCompleteAnchor();
    const source = canonicalSource(contextSource);
    let snapshot: SearchSnapshot = session;
    if (parsed.selector === "all") {
      if (session.refreshedComplete?.complete === true) {
        snapshot = session.refreshedComplete;
      } else if (session.refreshedComplete !== undefined) {
        snapshot = await this.#refresh(session, signal);
        if (!snapshot.complete) return missingCompleteAnchor();
      }
    }
    let selected = selectMatches(snapshot, parsed.selector, parsed.mode);
    let sourceMatches = selected.filter((match) => match.source === source);
    if (sourceMatches.length === 0) {
      return {
        kind: "rejected",
        rejection: { code: "missing", reason: "search anchor does not select this resource" },
      };
    }
    const current = await readCurrent(source, signal, session.environment, session.read);
    if (current === undefined) return staleAnchor(requiredValue(sourceMatches[0]).lineNumber);
    if (parsed.selector === "all" && current !== snapshot.contentBySource.get(source)) {
      snapshot = await this.#refresh(session, signal);
      if (!snapshot.complete) return missingCompleteAnchor();
      selected = selectMatches(snapshot, parsed.selector, parsed.mode);
      sourceMatches = selected.filter((match) => match.source === source);
    }
    if (sourceMatches.length === 0) {
      return {
        kind: "rejected",
        rejection: { code: "missing", reason: "search anchor does not select this resource" },
      };
    }
    if (parsed.selector !== "all" && current !== session.contentBySource.get(source))
      return staleAnchor(requiredValue(sourceMatches[0]).lineNumber);
    const document = createTextDocument(source, current);
    return {
      kind: "resolved",
      anchor: new TextSelectionAnchor(
        value,
        source,
        sourceMatches.map((match) => selectionRange(document, match, parsed.mode)),
      ),
    };
  }

  async #resolveResources(
    value: string,
    cwd: string,
    signal?: AbortSignal,
    allowEmpty = false,
  ): Promise<TextTargetResolutionAttempt> {
    const parsed = parseSearchAnchor(value);
    if (parsed === undefined) return { kind: "not-handled" };
    const session = this.#sessions.get(parsed.id);
    if (session === undefined || session.cwd !== canonicalSource(cwd)) return staleAnchor();
    if (parsed.selector === "all" && !session.complete) return missingCompleteAnchor();
    let snapshot: SearchSnapshot = session;
    if (parsed.selector === "all") {
      if (session.refreshedComplete?.complete === true) {
        snapshot = session.refreshedComplete;
      } else if (session.refreshedComplete !== undefined) {
        snapshot = await this.#refresh(session, signal);
        if (!snapshot.complete) return missingCompleteAnchor();
      }
      const sources = new Set(
        selectMatches(snapshot, parsed.selector, parsed.mode).map((match) => match.source),
      );
      for (const source of sources) {
        const current = await readCurrent(source, signal, session.environment, session.read);
        if (current !== snapshot.contentBySource.get(source)) {
          snapshot = await this.#refresh(session, signal);
          if (!snapshot.complete) return missingCompleteAnchor();
          break;
        }
      }
    }
    const selected = selectMatches(snapshot, parsed.selector, parsed.mode);
    if (parsed.selector !== "all") {
      const source = selected[0]?.source;
      if (
        source !== undefined &&
        (await readCurrent(source, signal, session.environment, session.read)) !==
          snapshot.contentBySource.get(source)
      ) {
        return staleAnchor(selected[0]?.lineNumber);
      }
    }
    const grouped = new Map<string, TextSelectionRange[]>();
    for (const match of selected) {
      const ranges = grouped.get(match.source) ?? [];
      ranges.push(
        selectionRange(
          createTextDocument(
            match.source,
            snapshot.contentBySource.get(match.source) ?? match.lineText,
          ),
          match,
          parsed.mode,
        ),
      );
      grouped.set(match.source, ranges);
    }
    const targets: TextTarget[] = [...grouped].map(([source, ranges]) => ({
      source,
      ranges,
      expectedContent: snapshot.contentBySource.get(source),
    }));
    return targets.length === 0 && !(allowEmpty && parsed.selector === "all")
      ? { kind: "rejected", rejection: { code: "missing", reason: "search anchor has no matches" } }
      : { kind: "resolved", targets };
  }

  async #refresh(session: StoredSearchSession, signal?: AbortSignal): Promise<SearchSnapshot> {
    const result =
      session.refresh === undefined
        ? await runSearchRecipe(session.recipe, session.cwd, signal, session.environment)
        : await session.refresh(signal);
    const matches = result.matches
      .map((match) => ({ ...match, source: canonicalSource(match.source) }))
      .sort(compareMatches);
    const refreshed: SearchSnapshot = {
      matches,
      complete: result.complete,
      contentBySource: await snapshotContents(
        matches,
        signal,
        session.snapshotByteBudget,
        session.environment,
        session.read,
      ),
    };
    this.#sessions.set(session.id, { ...session, refreshedComplete: refreshed });
    return refreshed;
  }
}

function registerResultReferences(
  store: ResultTargetStore | undefined,
  sessionId: string,
  matches: readonly TextSearchMatch[],
  contents: ReadonlyMap<string, string>,
  cwd: string,
  complete: boolean,
  read: SnapshotReader,
): Pick<TextSearchSession, "target" | "matchTargets"> {
  if (store === undefined) return {};
  const documents = new Map(
    [...contents].map(([source, content]) => [source, createTextDocument(source, content)]),
  );
  const targets = matches.map((match) => ({
    source: match.source,
    expectedContent: requiredValue(contents.get(match.source)),
    ranges: [selectionRange(requiredValue(documents.get(match.source)), match, "match")],
    readCurrent: (signal?: AbortSignal) => read(match.source, signal),
  }));
  for (const [index, match] of matches.slice(0, 100).entries()) {
    const lineTarget = store.register(
      [
        {
          ...requiredValue(targets[index]),
          ranges: [selectionRange(requiredValue(documents.get(match.source)), match, "line")],
        },
      ],
      cwd,
    );
    store.registerSearchReference(`SEARCH#${sessionId}:${index + 1}:line`, lineTarget, cwd);
  }
  return {
    target: store.register(targets, cwd, complete),
    matchTargets: targets.slice(0, 100).map((target) => store.register([target], cwd, complete)),
  };
}
function parseSearchAnchor(value: string): ParsedSearchAnchor | undefined {
  const match = searchAnchorPattern.exec(value);

  if (match === null) {
    return undefined;
  }

  return {
    id: requiredValue(match[1]),
    selector: match[2] === "all" ? "all" : Number(match[2]),
    mode: match[3] === "line" ? "line" : "match",
  };
}

function selectMatches(
  session: SearchSnapshot,
  selector: "all" | number,
  mode: "line" | "match",
): readonly TextSearchMatch[] {
  const selected =
    selector === "all" ? session.matches : [session.matches[selector - 1]].filter(isMatch);
  if (mode === "match" || selector !== "all") {
    return selected;
  }

  const seenLines = new Set<string>();
  return selected.flatMap((match) => {
    const document = createTextDocument(
      match.source,
      session.contentBySource.get(match.source) ?? match.lineText,
    );
    const last = lastContainingLine(match);
    return document.lines.slice(match.lineNumber - 1, last).flatMap((line) => {
      const key = `${match.source}\u0000${String(line.lineNumber)}`;
      if (seenLines.has(key)) return [];
      seenLines.add(key);
      return [
        {
          ...match,
          lineNumber: line.lineNumber,
          endLineNumber: line.lineNumber,
          startColumn: 0,
          endColumn: line.content.length,
          lineText: line.content,
          matchedText: line.content,
        },
      ];
    });
  });
}

function isMatch(value: TextSearchMatch | undefined): value is TextSearchMatch {
  return value !== undefined;
}

function lastContainingLine(match: TextSearchMatch): number {
  const end = match.endLineNumber ?? match.lineNumber;
  return end > match.lineNumber && match.endColumn === 0 ? end - 1 : end;
}
function selectionRange(
  document: ReturnType<typeof createTextDocument>,
  match: TextSearchMatch,
  mode: "line" | "match",
): TextSelectionRange {
  if (mode === "match") {
    return {
      start: { lineNumber: match.lineNumber, column: match.startColumn },
      end: { lineNumber: match.endLineNumber ?? match.lineNumber, column: match.endColumn },
    };
  }

  const lastLine = lastContainingLine(match);
  const line = requiredValue(document.lines[lastLine - 1]);
  return {
    start: { lineNumber: match.lineNumber, column: 0 },
    end: {
      lineNumber: lastLine + (line.lineEnding.length > 0 ? 1 : 0),
      column: line.lineEnding.length > 0 ? 0 : line.content.length,
    },
    linewise: true,
  };
}

function matchedSourceText(
  document: ReturnType<typeof createTextDocument>,
  match: TextSearchMatch,
): string {
  const endLine = match.endLineNumber ?? match.lineNumber;
  return document.lines
    .slice(match.lineNumber - 1, endLine)
    .map((line) => {
      const start = line.lineNumber === match.lineNumber ? match.startColumn : 0;
      const end = line.lineNumber === endLine ? match.endColumn : line.content.length;
      return line.content.slice(start, end) + (line.lineNumber === endLine ? "" : line.lineEnding);
    })
    .join("");
}
async function snapshotContents(
  matches: readonly TextSearchMatch[],
  signal?: AbortSignal,
  byteBudget?: number,
  environment?: SearchEnvironment,
  read?: SnapshotReader,
): Promise<ReadonlyMap<string, string>> {
  const sources = [...new Set(matches.map((match) => match.source))];
  if (byteBudget !== undefined) {
    const contents = new Map<string, string>();
    let remaining = byteBudget;
    for (const source of sources) {
      const content = await readBoundedSnapshot(source, remaining, signal, environment, read);
      remaining -= Buffer.byteLength(content);
      validateSnapshot(source, content, matches);
      contents.set(source, content);
    }
    return contents;
  }
  const snapshots = await Promise.allSettled(
    sources.map(async (source) => {
      const content = await readOwnedText(source, signal, environment, read);
      validateSnapshot(source, content, matches);
      return [source, content] as const;
    }),
  );
  const contentBySource = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (snapshot.status === "rejected") throw snapshot.reason;
    contentBySource.set(...snapshot.value);
  }
  return contentBySource;
}

function validateSnapshot(
  source: string,
  content: string,
  matches: readonly TextSearchMatch[],
): void {
  const document = createTextDocument(source, content);
  for (const match of matches.filter((candidate) => candidate.source === source)) {
    const line = document.lines[match.lineNumber - 1]?.content;
    if (line !== match.lineText || matchedSourceText(document, match) !== match.matchedText)
      throw new SearchSnapshotChangedError(source);
  }
}
async function readBoundedSnapshot(
  source: string,
  budget: number,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
  read?: SnapshotReader,
): Promise<string> {
  signal?.throwIfAborted();
  if (source.includes("://")) {
    const content = await readOwnedText(source, signal, environment, read);
    if (Buffer.byteLength(content) > budget)
      throw new Error("Candidate snapshot byte budget reached.");
    return content;
  }
  const file = await open(source, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > budget)
      throw new Error("Candidate snapshot byte budget reached.");
    const buffer = Buffer.alloc(Math.min(info.size + 1, budget + 1));
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    signal?.throwIfAborted();
    if (length > info.size || length > budget)
      throw new Error("Candidate file grew during snapshot capture.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
async function readCurrent(
  source: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
  read?: SnapshotReader,
): Promise<string | undefined> {
  try {
    return await readOwnedText(source, signal, environment, read);
  } catch {
    return undefined;
  }
}

function canonicalSource(source: string): string {
  return source.includes("://") ? source : path.resolve(source);
}
function resolveScope(cwd: string, source: string): string {
  if (source.includes("://")) return source;
  return cwd.includes("://")
    ? new URL(source, cwd.endsWith("/") ? cwd : cwd + "/").href
    : path.resolve(cwd, source);
}
async function readOwnedText(
  source: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
  read?: SnapshotReader,
): Promise<string> {
  signal?.throwIfAborted();
  if (read !== undefined) return read(source, signal);
  if (environment !== undefined) return environment.readText(source, signal);
  if (source.includes("://")) throw new Error("No search snapshot owner for this source.");
  return readFile(source, { encoding: "utf8", ...(signal !== undefined && { signal }) });
}
function staleAnchor(
  lineNumber = 1,
): Extract<TextAnchorResolutionAttempt, { readonly kind: "rejected" }> {
  return {
    kind: "rejected",
    rejection: {
      code: "stale",
      reason: "search anchor is stale",
      contextRange: { offset: Math.max(1, lineNumber - 2), limit: 5 },
    },
  };
}

function missingCompleteAnchor(): Extract<
  TextAnchorResolutionAttempt,
  { readonly kind: "rejected" }
> {
  return {
    kind: "rejected",
    rejection: {
      code: "missing",
      reason: "search did not register an all anchor because its result was limited",
    },
  };
}

function commonSourceDirectory(sources: readonly string[]): string {
  if (sources.length === 0) {
    return ".";
  }

  let common = path.dirname(path.resolve(requiredValue(sources[0])));

  for (const source of sources.slice(1)) {
    const absolute = path.resolve(source);

    while (!isWithin(common, absolute)) {
      const parent = path.dirname(common);

      if (parent === common) {
        return common;
      }

      common = parent;
    }
  }

  return common;
}

function isWithin(directory: string, source: string): boolean {
  const relative = path.relative(directory, source);
  // oxlint-disable-next-line repo/no-parent-paths -- defensive check against traversal, not a traversal
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function compareMatches(left: TextSearchMatch, right: TextSearchMatch): number {
  return (
    left.source.localeCompare(right.source) ||
    left.lineNumber - right.lineNumber ||
    left.startColumn - right.startColumn ||
    (left.endLineNumber ?? left.lineNumber) - (right.endLineNumber ?? right.lineNumber) ||
    left.endColumn - right.endColumn
  );
}
