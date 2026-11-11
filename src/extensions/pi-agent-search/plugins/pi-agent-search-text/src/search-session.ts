import { requiredValue } from "pi-agent-invariant";
import {
  createLineMap,
  rangesInText,
  rebaseOrRelocateRange,
  type ResultTargetStore,
  type ResolvedResultTargets,
} from "pi-agent-resource";
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
  type TextEditRun,
  type TextTarget,
  type TextTargetResolutionAttempt,
} from "pi-agent-text";
import {
  TextSelectionAnchor,
  type TextSelectionRange,
} from "pi-agent-text-editor/api/text-selection-anchor";

import type { TextAnchorResourceResolver } from "pi-agent-text-editor/api/plugin-protocol";
import { runSearchRecipe, type SearchRecipe } from "#src/search-recipe.ts";

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
  /** Digests, not text: a retained snapshot must not keep a copy of every searched file. */
  readonly digestBySource: ReadonlyMap<string, string>;
}

/** A snapshot with the source text it was captured from, held only while one request runs. */
interface CapturedSearchSnapshot {
  readonly snapshot: SearchSnapshot;
  readonly contents: ReadonlyMap<string, string>;
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
    paths: recipe.paths?.map((source) => resolveScope(cwd, source)) ?? [],
    include: recipe.include ?? "",
    exclude: recipe.exclude ?? "",
    caseSensitive: recipe.caseSensitive === true,
    wholeWord: recipe.wholeWord === true,
    multiline: recipe.multiline === true,
    limit: recipe.limit ?? 50,
    regex: recipe.regex === true,
    condition: recipe.condition,
    fallbacks: recipe.fallbacks ?? [],
  };
}

/** Indicates that search output is still displayable, but no stable anchors can be registered. */
export class SearchSnapshotChangedError extends Error {
  public constructor(readonly source: string) {
    super(`Search result in ${source} changed before its anchors were registered.`);
    this.name = "SearchSnapshotChangedError";
  }
}

/**
 * A repeated search for an all-anchor could not produce current matches. The message names the
 * cause and the next step. `SOURCE_CHANGED` marks a file another writer changed meanwhile: an
 * edit retries it on the current text.
 */
export class SearchRefreshError extends Error {
  public constructor(
    message: string,
    readonly code: "SOURCE_CHANGED" | "SCOPE_CHANGED" | "REFRESH_FAILED",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SearchRefreshError";
  }
}

/** Stores search snapshots and resolves the stable anchors emitted for them. */
export class SearchSessionStore {
  readonly #sessions = new Map<string, StoredSearchSession>();
  readonly #idsByIdentity = new Map<string, string>();
  /**
   * The all-selection snapshot each running edit found current, with the text it described, by
   * search session. It lives only as long as that edit; a session itself keeps no file text.
   */
  readonly #confirmed = new WeakMap<TextEditRun, Map<string, CapturedSearchSnapshot>>();

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
    // Sessions live as long as their anchors. A copied match keeps only its own text, not the
    // whole file that its line or match text was cut from.
    const matches = structuredClone(sourceMatches)
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
      digestBySource: digestContents(contentBySource),
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
      tryResolve: (value, context) =>
        this.#resolveAnchor(value, context.source, context.content, context.signal),
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
      tryResolve: (value, context) =>
        this.#resolveResources(value, context.cwd, context.signal, false, context.edit),
    };
  }

  /**
   * `callerContent` is the text the caller reads and edits. A numbered reference the result store
   * holds resolves in that text: another session may write the file meanwhile, and a selection
   * the store already moved to a newer text moves back onto the caller's text through unchanged
   * lines. Other references compare the owner's current text with the search snapshot.
   */
  async #resolveAnchor(
    value: string,
    contextSource: string,
    callerContent: string,
    signal?: AbortSignal,
  ): Promise<TextAnchorResolutionAttempt> {
    const parsed = parseSearchAnchor(value);
    if (parsed === undefined) return { kind: "not-handled" };
    const session = this.#sessions.get(parsed.id);
    if (session === undefined) return staleAnchor();
    if (parsed.selector === "all" && !session.complete) return missingCompleteAnchor();
    const source = canonicalSource(contextSource);
    let snapshot: SearchSnapshot = session;
    let refreshedContents: ReadonlyMap<string, string> | undefined;
    if (parsed.selector === "all") {
      if (session.refreshedComplete?.complete === true) {
        snapshot = session.refreshedComplete;
      } else if (session.refreshedComplete !== undefined) {
        ({ snapshot, contents: refreshedContents } = await this.#refresh(session, signal));
        if (!snapshot.complete) return missingCompleteAnchor(true);
      }
    }
    const firstMatch = selectMatches(snapshot, parsed.selector, "match").find(
      (match) => match.source === source,
    );
    if (firstMatch === undefined) {
      return {
        kind: "rejected",
        rejection: { code: "missing", reason: "search anchor does not select this resource" },
      };
    }
    if (parsed.selector !== "all") {
      const bound = this.#resolveBound(value, session.cwd);
      if (bound?.kind === "rejected") return bound;
      if (bound?.kind === "resolved") {
        const target = bound.targets.find(
          (candidate) => canonicalSource(candidate.source) === source,
        );
        if (target?.ranges === undefined)
          return {
            kind: "rejected",
            rejection: { code: "missing", reason: "search anchor does not select this resource" },
          };
        const ranges =
          target.expectedContent === callerContent
            ? target.ranges
            : target.expectedContent === undefined
              ? undefined
              : rangesInText(target.ranges, target.expectedContent, callerContent);
        if (ranges === undefined)
          return staleAnchor(target.ranges[0]?.start.lineNumber ?? firstMatch.lineNumber);
        return {
          kind: "resolved",
          anchor: new TextSelectionAnchor(value, source, [...ranges]),
        };
      }
    }
    // The caller's text, the same text numbered references resolve in above.
    const current = callerContent;
    const currentDigest = digestContent(current);
    if (parsed.selector === "all" && currentDigest !== snapshot.digestBySource.get(source)) {
      ({ snapshot, contents: refreshedContents } = await this.#refresh(session, signal));
      if (!snapshot.complete) return missingCompleteAnchor(true);
    }
    const contentOf = (candidate: string) =>
      refreshedContents === undefined
        ? candidate === source
          ? current
          : undefined
        : refreshedContents.get(candidate);
    const sourceMatches = selectMatches(snapshot, parsed.selector, parsed.mode, contentOf).filter(
      (match) => match.source === source,
    );
    if (sourceMatches.length === 0) {
      return {
        kind: "rejected",
        rejection: { code: "missing", reason: "search anchor does not select this resource" },
      };
    }
    if (parsed.selector !== "all" && currentDigest !== session.digestBySource.get(source))
      return staleAnchor(requiredValue(sourceMatches[0]).lineNumber);
    // A search run again here read the file itself; its matches move onto the caller's text.
    const found = refreshedContents?.get(source) ?? current;
    const document = createTextDocument(source, found);
    const ranges = rangesInText(
      sourceMatches.map((match) => selectionRange(document, match, parsed.mode)),
      found,
      current,
    );
    if (ranges === undefined) return staleAnchor(requiredValue(sourceMatches[0]).lineNumber);
    return {
      kind: "resolved",
      anchor: new TextSelectionAnchor(value, source, ranges),
    };
  }

  async #resolveResources(
    value: string,
    cwd: string,
    signal?: AbortSignal,
    allowEmpty = false,
    edit?: TextEditRun,
  ): Promise<TextTargetResolutionAttempt> {
    const parsed = parseSearchAnchor(value);
    if (parsed === undefined) return { kind: "not-handled" };
    const session = this.#sessions.get(parsed.id);
    if (session === undefined || session.cwd !== canonicalSource(cwd)) return staleAnchor();
    if (parsed.selector === "all" && !session.complete) return missingCompleteAnchor();
    if (parsed.selector !== "all") {
      const bound = this.#resolveBound(value, session.cwd);
      if (bound !== undefined) return bound;
    }
    let snapshot: SearchSnapshot = session;
    // Text of every selected source, verified against the snapshot digest or freshly refreshed.
    let contents = new Map<string, string>();
    if (parsed.selector === "all") {
      if (session.refreshedComplete?.complete === true) {
        snapshot = session.refreshedComplete;
      } else if (session.refreshedComplete !== undefined) {
        ({ snapshot } = await this.#refresh(session, signal));
        if (!snapshot.complete) return missingCompleteAnchor(true);
      }
      // What an earlier attempt of this edit found current; see `#moveConfirmed`.
      const confirmed = edit === undefined ? undefined : this.#confirmed.get(edit)?.get(session.id);
      const sources = new Set(
        selectMatches(snapshot, parsed.selector, "match").map((match) => match.source),
      );
      for (const source of sources) {
        const current = await readCurrent(source, signal, session.environment, session.read);
        if (
          current === undefined ||
          digestContent(current) !== snapshot.digestBySource.get(source)
        ) {
          const next =
            (confirmed === undefined
              ? undefined
              : await this.#moveConfirmed(session, confirmed, signal)) ??
            (await this.#refresh(session, signal));
          snapshot = next.snapshot;
          contents = new Map(next.contents);
          if (!snapshot.complete) return missingCompleteAnchor(true);
          break;
        }
        contents.set(source, current);
      }
      if (edit !== undefined) {
        const bySession = this.#confirmed.get(edit) ?? new Map<string, CapturedSearchSnapshot>();
        bySession.set(session.id, { snapshot, contents });
        this.#confirmed.set(edit, bySession);
      }
    } else {
      const first = selectMatches(snapshot, parsed.selector, parsed.mode)[0];
      if (first !== undefined) {
        const current = await readCurrent(first.source, signal, session.environment, session.read);
        if (
          current === undefined ||
          digestContent(current) !== snapshot.digestBySource.get(first.source)
        )
          return staleAnchor(first.lineNumber);
        contents.set(first.source, current);
      }
    }
    const selected = selectMatches(snapshot, parsed.selector, parsed.mode, (source) =>
      contents.get(source),
    );
    const documents = new Map<string, ReturnType<typeof createTextDocument>>();
    const documentOf = (match: TextSearchMatch) => {
      let document = documents.get(match.source);
      if (document === undefined) {
        document = createTextDocument(match.source, contents.get(match.source) ?? match.lineText);
        documents.set(match.source, document);
      }
      return document;
    };
    const grouped = new Map<string, TextSelectionRange[]>();
    for (const match of selected) {
      const ranges = grouped.get(match.source) ?? [];
      ranges.push(selectionRange(documentOf(match), match, parsed.mode));
      grouped.set(match.source, ranges);
    }
    const targets: TextTarget[] = [...grouped].map(([source, ranges]) => ({
      source,
      ranges,
      expectedContent: contents.get(source),
    }));
    return targets.length === 0 && !(allowEmpty && parsed.selector === "all")
      ? { kind: "rejected", rejection: { code: "missing", reason: "search anchor has no matches" } }
      : { kind: "resolved", targets };
  }

  /**
   * A numbered reference is bound to the result store when its search registers. The store moves
   * it through edits elsewhere in the file and says what changed when it cannot. Undefined when
   * no store owns the reference.
   */
  #resolveBound(
    value: string,
    cwd: string,
  ):
    | { readonly kind: "resolved"; readonly targets: readonly TextTarget[] }
    | Extract<TextTargetResolutionAttempt, { readonly kind: "rejected" }>
    | undefined {
    if (this.resultTargets === undefined) return undefined;
    try {
      const resolved = this.resultTargets.resolveSearchReference(value, cwd);
      if (resolved === undefined) return undefined;
      return {
        kind: "resolved",
        targets: resolved.targets.map((target) => ({
          source: target.source,
          ranges: target.ranges,
          expectedContent: target.expectedContent,
        })),
      };
    } catch (error) {
      return {
        kind: "rejected",
        rejection: {
          code: "stale",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * A retry of an edit whose file another process changed: move the matches its earlier attempt
   * found current onto the newer text instead of searching again, which would take long enough
   * for the next write to come in. Only matches whose lines are all unchanged move, and only
   * when no added or changed line contains a matched text, so the result is what a new search
   * would find. Undefined when that cannot be shown; the caller then searches again.
   */
  async #moveConfirmed(
    session: StoredSearchSession,
    confirmed: CapturedSearchSnapshot,
    signal?: AbortSignal,
  ): Promise<CapturedSearchSnapshot | undefined> {
    const bySource = new Map<string, TextSearchMatch[]>();
    for (const match of confirmed.snapshot.matches)
      bySource.set(match.source, [...(bySource.get(match.source) ?? []), match]);
    const matches: TextSearchMatch[] = [];
    const contents = new Map<string, string>();
    for (const [source, sourceMatches] of bySource) {
      const before = confirmed.contents.get(source);
      const now = await readCurrent(source, signal, session.environment, session.read);
      if (before === undefined || now === undefined) return undefined;
      contents.set(source, now);
      if (now === before) {
        matches.push(...sourceMatches);
        continue;
      }
      const moved = moveMatches(source, sourceMatches, before, now);
      if (moved === undefined) return undefined;
      matches.push(...moved);
    }
    const snapshot: SearchSnapshot = {
      matches: matches.sort(compareMatches),
      complete: confirmed.snapshot.complete,
      digestBySource: digestContents(contents),
    };
    this.#sessions.set(session.id, { ...session, refreshedComplete: snapshot });
    return { snapshot, contents };
  }

  async #refresh(
    session: StoredSearchSession,
    signal?: AbortSignal,
  ): Promise<CapturedSearchSnapshot> {
    let matches: TextSearchMatch[];
    let complete: boolean;
    let contents: ReadonlyMap<string, string>;
    try {
      const result =
        session.refresh === undefined
          ? await runSearchRecipe(session.recipe, session.cwd, signal, session.environment)
          : await session.refresh(signal);
      complete = result.complete;
      matches = result.matches
        .map((match) => ({ ...match, source: canonicalSource(match.source) }))
        .sort(compareMatches);
      const searchedBy = (result as { readonly contents?: ReadonlyMap<string, string> }).contents;
      const searched =
        searchedBy === undefined
          ? undefined
          : new Map([...searchedBy].map(([source, text]) => [canonicalSource(source), text]));
      contents = await snapshotContents(
        matches,
        signal,
        session.snapshotByteBudget,
        session.environment,
        session.read,
        searched,
      );
    } catch (error) {
      throw refreshFailure(error, signal);
    }
    const snapshot: SearchSnapshot = {
      matches,
      complete,
      digestBySource: digestContents(contents),
    };
    this.#sessions.set(session.id, { ...session, refreshedComplete: snapshot });
    return { snapshot, contents };
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
  // Registered targets outlive this call. Their readers come from `sourceReader`, so no closure
  // keeps these split-line documents alive.
  const documents = new Map<string, ReturnType<typeof createTextDocument>>();
  const documentOf = (source: string) => {
    let document = documents.get(source);
    if (document === undefined) {
      document = createTextDocument(source, requiredValue(contents.get(source)));
      documents.set(source, document);
    }
    return document;
  };
  const targets = matches.map((match) => ({
    source: match.source,
    expectedContent: requiredValue(contents.get(match.source)),
    ranges: [matchRange(match)],
    readCurrent: sourceReader(read, match.source),
  }));
  // Every match gets both references, whatever its number. A reference names exactly one range,
  // so it is complete for that range even when the search hit its limit; only `target`, which
  // stands for the whole search, carries the search's own completeness.
  const matchTargets: string[] = [];
  for (const [index, match] of matches.entries()) {
    const lineTarget = store.register(
      [
        {
          ...requiredValue(targets[index]),
          ranges: [selectionRange(documentOf(match.source), match, "line")],
        },
      ],
      cwd,
    );
    store.registerSearchReference(`SEARCH#${sessionId}:${index + 1}:line`, lineTarget, cwd);
    const matchTarget = store.register([requiredValue(targets[index])], cwd);
    store.registerSearchReference(`SEARCH#${sessionId}:${index + 1}:match`, matchTarget, cwd);
    matchTargets.push(matchTarget);
  }
  return { target: store.register(targets, cwd, complete), matchTargets };
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

/** Kept outside the functions that build documents, so a retained reader holds only its source. */
function sourceReader(
  read: SnapshotReader,
  source: string,
): (signal?: AbortSignal) => Promise<string> {
  return (signal) => read(source, signal);
}

function digestContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function digestContents(contents: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return new Map([...contents].map(([source, content]) => [source, digestContent(content)]));
}

/** `contentOf` supplies verified source text; whole-line selections of every match need it. */
function selectMatches(
  session: SearchSnapshot,
  selector: "all" | number,
  mode: "line" | "match",
  contentOf: (source: string) => string | undefined = () => undefined,
): readonly TextSearchMatch[] {
  const selected =
    selector === "all" ? session.matches : [session.matches[selector - 1]].filter(isMatch);
  if (mode === "match" || selector !== "all") {
    return selected;
  }

  const seenLines = new Set<string>();
  const documents = new Map<string, ReturnType<typeof createTextDocument>>();
  return selected.flatMap((match) => {
    const content = contentOf(match.source);
    let document = content === undefined ? undefined : documents.get(match.source);
    if (document === undefined) {
      document = createTextDocument(match.source, content ?? match.lineText);
      if (content !== undefined) documents.set(match.source, document);
    }
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
  if (mode === "match") return matchRange(match);

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

function matchRange(match: TextSearchMatch): TextSelectionRange {
  return {
    start: { lineNumber: match.lineNumber, column: match.startColumn },
    end: { lineNumber: match.endLineNumber ?? match.lineNumber, column: match.endColumn },
  };
}

/**
 * Matches of one source moved from the text they were found in onto its newer text through
 * unchanged lines. Undefined when a match cannot move with its exact text, or when an added or
 * changed line holds a matched text and so may hold a match that searching again would find.
 */
function moveMatches(
  source: string,
  matches: readonly TextSearchMatch[],
  before: string,
  after: string,
): TextSearchMatch[] | undefined {
  const map = createLineMap(before, after);
  if (map === undefined) return undefined;
  const texts = new Set(matches.map((match) => match.matchedText.split("\n")[0] ?? ""));
  if (texts.has("")) return undefined;
  const kept = new Set(map.table);
  for (let line = 1; line <= map.newLines.length; line += 1) {
    if (kept.has(line)) continue;
    const text = map.newLines[line - 1] ?? "";
    for (const matched of texts) if (text.includes(matched)) return undefined;
  }
  const document = createTextDocument(source, after);
  const moved: TextSearchMatch[] = [];
  for (const match of matches) {
    const range = rebaseOrRelocateRange(
      {
        start: { lineNumber: match.lineNumber, column: match.startColumn },
        end: { lineNumber: match.endLineNumber ?? match.lineNumber, column: match.endColumn },
      },
      map,
    );
    if (range === undefined) return undefined;
    const next: TextSearchMatch = {
      ...match,
      lineNumber: range.start.lineNumber,
      ...(match.endLineNumber !== undefined && { endLineNumber: range.end.lineNumber }),
      startColumn: range.start.column,
      endColumn: range.end.column,
      lineText: document.lines[range.start.lineNumber - 1]?.content ?? "",
    };
    if (matchedSourceText(document, next) !== match.matchedText) return undefined;
    moved.push(next);
  }
  return moved;
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
  searched?: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const sources = [...new Set(matches.map((match) => match.source))];
  if (byteBudget !== undefined) {
    const contents = new Map<string, string>();
    let remaining = byteBudget;
    for (const source of sources) {
      const known = searched?.get(source);
      if (known !== undefined && Buffer.byteLength(known) > remaining)
        throw new Error("Candidate snapshot byte budget reached.");
      const content =
        known ?? (await readBoundedSnapshot(source, remaining, signal, environment, read));
      remaining -= Buffer.byteLength(content);
      validateSnapshot(source, content, matches);
      contents.set(source, content);
    }
    return contents;
  }
  const snapshots = await Promise.allSettled(
    sources.map(async (source) => {
      const content =
        searched?.get(source) ?? (await readOwnedText(source, signal, environment, read));
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

function missingCompleteAnchor(
  refreshed = false,
): Extract<TextAnchorResolutionAttempt, { readonly kind: "rejected" }> {
  return {
    kind: "rejected",
    rejection: {
      code: "missing",
      reason: refreshed
        ? "the file changed and the repeated search found more matches than its limit, so the all anchor no longer selects every match; search again with a higher limit or a narrower path"
        : "search did not register an all anchor because its result was limited; search again with a higher limit or a narrower path, or pass its numbered anchors",
    },
  };
}

/**
 * Names why a repeated search failed and what to do next. Cancellation stays as it is; a file
 * that changed while the search ran again is a source change, which an edit retries.
 */
function refreshFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true || error instanceof SearchRefreshError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof SearchSnapshotChangedError || code === "SOURCE_CHANGED")
    return new SearchRefreshError(
      `${error instanceof SearchSnapshotChangedError ? error.source : "A searched file"} changed while its search ran again, because another process is writing it. Repeat the search and use its new anchors.`,
      "SOURCE_CHANGED",
      { cause: error },
    );
  if (code === "SCOPE_CHANGED")
    return new SearchRefreshError(message, "SCOPE_CHANGED", { cause: error });
  return new SearchRefreshError(
    `The search could not run again: ${message}. Repeat the search; if it fails the same way, report it as a tool error.`,
    "REFRESH_FAILED",
    { cause: error },
  );
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
