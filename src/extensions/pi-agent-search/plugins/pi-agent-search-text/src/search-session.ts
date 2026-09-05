import { requiredValue } from "pi-agent-invariant";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

export interface TextSearchMatch {
  readonly source: string;
  readonly lineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly matchedText: string;
  readonly lineText: string;
}

export interface TextSearchSession {
  readonly id: string;
  readonly query: string;
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
}

interface SearchSnapshot {
  readonly matches: readonly TextSearchMatch[];
  readonly complete: boolean;
  readonly contentBySource: ReadonlyMap<string, string>;
}

interface StoredSearchSession extends TextSearchSession, SearchSnapshot {
  readonly recipe: SearchRecipe;
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
      : path.resolve(cwd);
  const identity = matches
    .map((match) => ({
      match,
      source: path.relative(root, path.resolve(match.source)),
    }))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) || compareMatches(left.match, right.match),
    )
    .map(({ match, source }) => [
      source,
      match.lineNumber,
      match.startColumn,
      match.endColumn,
      match.matchedText,
      match.lineText,
    ]);
  const normalizedRecipe = normalizeRecipe(recipe ?? { query, regex: true }, root);
  return createHash("sha256")
    .update(JSON.stringify([query, root, normalizedRecipe, identity]))
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
    path: path.resolve(cwd, recipe.path ?? "."),
    include: recipe.include ?? "",
    exclude: recipe.exclude ?? "",
    caseSensitive: recipe.caseSensitive === true,
    wholeWord: recipe.wholeWord === true,
    limit: recipe.limit ?? 100,
    regex: recipe.regex === true,
    fallbacks: recipe.fallbacks ?? [],
  };
}

/** Stores search snapshots and resolves the stable anchors emitted for them. */
export class SearchSessionStore {
  readonly #sessions = new Map<string, StoredSearchSession>();
  readonly #idsByIdentity = new Map<string, string>();

  public constructor(
    private readonly createIdentity: typeof createSearchSessionIdentity = createSearchSessionIdentity,
  ) {}

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
  ): Promise<TextSearchSession> {
    const matches = sourceMatches
      .map((match) => ({ ...match, source: path.resolve(match.source) }))
      .sort(compareMatches);
    const contentBySource = await snapshotContents(matches, signal);
    const identity = this.createIdentity(query, matches, cwd, recipe);
    const knownId = this.#idsByIdentity.get(identity);
    const id = knownId ?? allocateSearchSessionId(identity, new Set<string>(this.#sessions.keys()));
    const session: StoredSearchSession = {
      id,
      query,
      matches,
      complete,
      contentBySource,
      recipe,
      cwd: path.resolve(cwd),
    };
    this.#idsByIdentity.set(identity, id);
    this.#sessions.set(id, session);
    return session;
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
    const source = path.resolve(contextSource);
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
    const current = await readCurrent(source, signal);
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

  async #resolveResources(value: string, _cwd: string): Promise<TextTargetResolutionAttempt> {
    const parsed = parseSearchAnchor(value);
    if (parsed === undefined) return { kind: "not-handled" };
    const session = this.#sessions.get(parsed.id);
    if (session === undefined) return staleAnchor();
    if (parsed.selector === "all" && !session.complete) return missingCompleteAnchor();
    let snapshot: SearchSnapshot = session;
    if (parsed.selector === "all") {
      if (session.refreshedComplete?.complete === true) {
        snapshot = session.refreshedComplete;
      } else if (session.refreshedComplete !== undefined) {
        snapshot = await this.#refresh(session);
        if (!snapshot.complete) return missingCompleteAnchor();
      }
      const sources = new Set(
        selectMatches(snapshot, parsed.selector, parsed.mode).map((match) => match.source),
      );
      for (const source of sources) {
        const current = await readCurrent(source);
        if (current !== snapshot.contentBySource.get(source)) {
          snapshot = await this.#refresh(session);
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
        (await readCurrent(source)) !== snapshot.contentBySource.get(source)
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
    const targets: TextTarget[] = [...grouped].map(([source, ranges]) => ({ source, ranges }));
    return targets.length === 0
      ? { kind: "rejected", rejection: { code: "missing", reason: "search anchor has no matches" } }
      : { kind: "resolved", targets };
  }

  async #refresh(session: StoredSearchSession, signal?: AbortSignal): Promise<SearchSnapshot> {
    const result = await runSearchRecipe(session.recipe, session.cwd, signal);
    const matches = result.matches
      .map((match) => ({ ...match, source: path.resolve(match.source) }))
      .sort(compareMatches);
    const refreshed: SearchSnapshot = {
      matches,
      complete: result.complete,
      contentBySource: await snapshotContents(matches, signal),
    };
    this.#sessions.set(session.id, { ...session, refreshedComplete: refreshed });
    return refreshed;
  }
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
  return selected.filter((match) => {
    const key = `${match.source}\u0000${String(match.lineNumber)}`;
    if (seenLines.has(key)) {
      return false;
    }
    seenLines.add(key);
    return true;
  });
}

function isMatch(value: TextSearchMatch | undefined): value is TextSearchMatch {
  return value !== undefined;
}

function selectionRange(
  document: ReturnType<typeof createTextDocument>,
  match: TextSearchMatch,
  mode: "line" | "match",
): TextSelectionRange {
  if (mode === "match") {
    return {
      start: { lineNumber: match.lineNumber, column: match.startColumn },
      end: { lineNumber: match.lineNumber, column: match.endColumn },
    };
  }

  const line = requiredValue(document.lines[match.lineNumber - 1]);
  return {
    start: { lineNumber: match.lineNumber, column: 0 },
    end: {
      lineNumber: match.lineNumber + (line.lineEnding.length > 0 ? 1 : 0),
      column: line.lineEnding.length > 0 ? 0 : line.content.length,
    },
    linewise: true,
  };
}

async function snapshotContents(
  matches: readonly TextSearchMatch[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const contentBySource = new Map<string, string>();
  for (const source of new Set(matches.map((match) => match.source))) {
    const content = await readFile(source, {
      encoding: "utf8",
      ...(signal !== undefined && { signal }),
    });
    const document = createTextDocument(source, content);
    for (const match of matches.filter((candidate) => candidate.source === source)) {
      const line = document.lines[match.lineNumber - 1]?.content;
      if (
        line !== match.lineText ||
        line.slice(match.startColumn, match.endColumn) !== match.matchedText
      ) {
        throw new Error(`Search result in ${source} changed before its anchors were registered.`);
      }
    }
    contentBySource.set(source, content);
  }
  return contentBySource;
}

async function readCurrent(source: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await readFile(source, { encoding: "utf8", ...(signal !== undefined && { signal }) });
  } catch {
    return undefined;
  }
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
    left.endColumn - right.endColumn
  );
}
