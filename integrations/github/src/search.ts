import type {
  SearchContext,
  SearchRequest,
  SearchResolver,
  SearchSelectionMatch,
  SearchSelectionProvider,
} from "pi-agent-ide/api/search";
import { selectionData } from "pi-agent-ide/api/search";
import { githubResourceError } from "./resource-error.ts";
import { matchText } from "./text-search.ts";
import { githubLocation as location } from "./environment.ts";
import type { GithubConnectionAccess, GithubConnectionBoundary } from "./connections/manager.ts";
import { assertGithubAccess, githubOperationSignal } from "./connections/boundary.ts";

/** Backend request for API-supported object discovery, separate from resource text matching. */
export interface GithubObjectSearch {
  readonly kind: string;
  readonly term: string;
  readonly repository: string;
  readonly scope: string;
  readonly limit: number;
}
/** Readable object identity returned by native search or a supported directory lookup. */
export interface GithubSearchItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}
/** One bounded backend page; incomplete coverage never means that an object is absent. */
export interface GithubObjectPage {
  readonly kind: string;
  readonly repository: string;
  readonly term: string;
  readonly items: readonly GithubSearchItem[];
  readonly complete: boolean;
  readonly next?: string;
  readonly notice?: string;
}
/** Native API boundary; implementations keep authorization outside the Search formatter. */
export type ObjectSearcher = (
  request: GithubObjectSearch,
  cwd: string,
  signal?: AbortSignal,
) => Promise<GithubObjectPage>;
/** Canonical source text, supplied by the public Read pipeline rather than rendered previews. */
export interface GithubTextSnapshot {
  readonly source: string;
  readonly content: string;
  readonly complete?: boolean;
}
/** Read exactly one selected resource; do not follow its links implicitly. */
export type ResourceTextReader = (
  source: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<GithubTextSnapshot>;

type MatchPage = {
  readonly mode: "text";
  readonly matches: readonly SearchSelectionMatch[];
  readonly complete: boolean;
  readonly selection?: {
    readonly id: string;
    readonly target?: string;
    readonly matchTargets?: readonly string[];
  };
};
type ObjectPage = { readonly mode: "objects"; readonly page: GithubObjectPage };
type Payload = MatchPage | ObjectPage;

function safeError(error: unknown, source: string): Error {
  return githubResourceError(error, source, "GH_SEARCH_FAILED");
}
function expression(request: SearchRequest): RegExp {
  if (request.query.length > 4096) throw new Error("GH_QUERY_TOO_LARGE");
  const regex = request.query.startsWith("regex:");
  let pattern = regex
    ? request.query.slice(6)
    : request.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!pattern) throw new Error("GH_EMPTY_QUERY");
  if (request.wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(pattern, request.caseSensitive ? "gu" : "giu");
  } catch {
    throw new Error("GH_INVALID_REGEX");
  }
}
function limit(request: SearchRequest): number {
  const value = request.limit ?? 50;
  if (!Number.isInteger(value) || value < 1) throw new Error("GH_INVALID_LIMIT");
  return Math.min(value, 100);
}

/** Register native object discovery and exact in-resource text search with the shared tool. */
export function createGithubSearchResolver(
  searchObjects: ObjectSearcher,
  readText: ResourceTextReader,
  registerSelection?: SearchSelectionProvider,
  boundary?: GithubConnectionBoundary,
  match: typeof matchText = matchText,
): SearchResolver {
  const textSearch = async (
    request: SearchRequest,
    context: SearchContext,
    register = true,
    origin?: GithubConnectionAccess,
  ): Promise<MatchPage> => {
    const access = origin ?? (await boundary?.capture(context.cwd, context.signal));
    const source = request.path ?? "github:";
    assertGithubAccess(access, source);
    const ownedRead: ResourceTextReader = async (path, cwd, signal) => {
      assertGithubAccess(access, path);
      const snapshot = await readText(path, cwd, githubOperationSignal(access, signal));
      assertGithubAccess(access, path);
      return snapshot;
    };
    if (boundary) context = { ...context, signal: githubOperationSignal(access, context.signal) };
    if (request.include || request.exclude) throw new Error("GH_GLOBS_UNSUPPORTED");
    const pattern = expression(request);
    const maximum = limit(request);
    const targets = context.scope?.targets;
    const sources = targets?.map((target) => target.source) ?? (request.path ? [request.path] : []);
    const matches: SearchSelectionMatch[] = [];
    const seen = new Set<string>();
    let complete = context.scope?.complete ?? true;
    for (const source of new Set(sources)) {
      context.signal?.throwIfAborted();
      if (!location(source)?.resource) throw new Error("GH_INVALID_SEARCH_SCOPE");
      const snapshot = await ownedRead(source, context.cwd, context.signal);
      const expected = targets?.filter((target) => target.source === source);
      if (expected?.some((target) => target.expectedContent !== snapshot.content))
        throw new Error("GH_SCOPE_STALE");
      if (snapshot.complete === false) complete = false;
      const found = await match(source, snapshot.content, pattern, maximum + 1, context);
      assertGithubAccess(access, source);
      for (const match of found) {
        const key = JSON.stringify([source, match.lineNumber, match.startColumn, match.endColumn]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (matches.length === maximum) {
          complete = false;
          break;
        }
        matches.push(match);
      }
      if (matches.length === maximum && !complete) break;
    }
    const payload: MatchPage = { mode: "text", matches, complete };
    if (!register || !registerSelection) return payload;
    const selection = await registerSelection(
      {
        matches,
        complete,
        request,
        refresh: async (signal) => {
          assertGithubAccess(access, source);
          const fresh = await textSearch(request, { ...context, signal }, false, access);
          return { matches: fresh.matches, complete: fresh.complete };
        },
      },
      context,
    );
    assertGithubAccess(access, source);
    // The shared store may return a live session with reader functions; expose only JSON fields.
    return {
      mode: "text",
      matches: selection.matches,
      complete: selection.complete,
      selection: {
        id: selection.id,
        ...(selection.target ? { target: selection.target } : {}),
        ...(selection.matchTargets ? { matchTargets: selection.matchTargets } : {}),
      },
    };
  };
  return {
    id: "github",
    supportsResultScope: true,
    readResources(request, context) {
      if (context.scope) return context.scope.targets.map((target) => target.source);
      return request.path ? [request.path] : [];
    },
    async tryResolve(request, context) {
      context.signal?.throwIfAborted();
      const native = /^github:([a-z][a-z-]*)\s+([\s\S]+)$/u.exec(request.query);
      const claimed = request.query.startsWith("github:");
      try {
        if (
          "navigation" in request &&
          request.navigation &&
          (claimed ||
            location(request.path)?.resource ||
            context.scope?.targets.some((target) => location(target.source)))
        )
          throw new Error("GH_SEARCH_OPTIONS_UNSUPPORTED");
        const sources = context.scope?.targets.map((target) => target.source);
        if (sources?.length && !sources.some((source) => location(source)))
          return { kind: "not-handled" };
        const path = request.path;
        const scope = location(path);
        if (claimed) {
          if (!native || path === undefined || !scope || context.scope)
            throw new Error("GH_INVALID_SEARCH_SCOPE");
          if (!scope.repository) throw new Error("GH_REPOSITORY_SCOPE_REQUIRED");
          if (request.include || request.exclude || request.caseSensitive || request.wholeWord)
            throw new Error("GH_API_SEARCH_OPTIONS_UNSUPPORTED");
          const page = await searchObjects(
            {
              kind: native[1],
              term: native[2].trim(),
              repository: scope.repository,
              scope: path,
              limit: Math.min(limit(request), 50),
            },
            context.cwd,
            context.signal,
          );
          return { kind: "resolved", payload: { mode: "objects", page } satisfies ObjectPage };
        }
        if (!sources?.length && !scope?.resource) return { kind: "not-handled" };
        return { kind: "resolved", payload: await textSearch(request, context) };
      } catch (error) {
        context.signal?.throwIfAborted();
        return { kind: "failed", error: safeError(error, request.path ?? "github:") };
      }
    },
    format(value) {
      const payload = value as Payload;
      const text =
        payload.mode === "objects"
          ? [
              `GitHub ${payload.page.kind}: ${payload.page.term}`,
              `Repository: ${payload.page.repository}`,
              `Returned: ${payload.page.items.length}`,
              payload.page.complete
                ? "End of results."
                : "More results available; coverage is incomplete.",
              ...(payload.page.next ? [`Next page: <${payload.page.next}>`] : []),
              ...(payload.page.notice ? [payload.page.notice] : []),
              "",
              ...payload.page.items.map(
                (item) => `- ${item.id}: ${item.title.replace(/[\r\n]+/gu, " ")}: <${item.url}>`,
              ),
            ].join("\n")
          : [
              `${payload.matches.length}${payload.complete ? "" : "+"} matches in selected GitHub text`,
              ...(payload.selection
                ? [`Selection: ${payload.selection.target ?? payload.selection.id}`]
                : []),
              ...payload.matches.map(
                (match, index) =>
                  `${match.source}:${match.lineNumber}:${match.startColumn} ${match.lineText}${payload.selection?.matchTargets?.[index] ? ` <${payload.selection.matchTargets[index]}>` : ""}`,
              ),
              ...(payload.complete ? [] : ["Coverage is incomplete; do not conclude absence."]),
            ].join("\n");
      return { content: [{ type: "text", text }], details: payload };
    },
    toScriptData(value) {
      const payload = value as Payload;
      return payload.mode === "objects"
        ? { kind: "custom", resolverId: "github", value: payload.page }
        : selectionData(
            payload.matches,
            payload.complete,
            payload.selection?.id,
            payload.selection,
          );
    },
  };
}
