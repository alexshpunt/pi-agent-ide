import type { SearchEnvironment } from "pi-agent-search/api/search";
import { unreadableNotice } from "#src/search-result.ts";
import {
  searchText,
  type TextSearchRequest,
  type TextSearchBackendResult,
  type ObserveSearchMatches,
} from "#src/search-backend.ts";
import {
  compileSearchQuery,
  compileSearchFallbackQuery,
  compileSearchCondition,
  type SearchCondition,
} from "#src/search-query.ts";

/** One optional broadening step after the previous search finds no matches. */
export interface SearchFallback {
  readonly query: string;
  readonly mode: "regex" | "words";
  readonly condition?: SearchCondition;
}

/** Replayable search inputs, including the same ordered fallbacks used by the original call. */
export interface SearchRecipe extends TextSearchRequest {
  /** User-facing query retained separately from the compiled matching expression. */
  readonly originalQuery?: string;
  readonly fallbacks?: readonly SearchFallback[];
}

/** Compile a local query into literal-first, regex, then eligible word-search steps. */
export function createSearchRecipe(request: TextSearchRequest): SearchRecipe {
  const query = compileSearchQuery(request.query);
  const regex = compileSearchQuery(request.query, true);
  const words = compileSearchFallbackQuery(request.query);
  const fallbacks: SearchFallback[] = [];
  const condition = compileSearchCondition(request.query);
  const regexCondition = compileSearchCondition(request.query, true);
  if (regex !== query || JSON.stringify(condition) !== JSON.stringify(regexCondition)) {
    fallbacks.push({ query: regex, mode: "regex", condition: regexCondition });
  }
  // Separate words cannot reproduce one match that spans lines.
  if (request.multiline !== true && words !== undefined && words !== query && words !== regex) {
    fallbacks.push({ query: words, mode: "words" });
  }
  return { ...request, query, regex: true, condition, fallbacks };
}

/** Run or refresh a recipe without hiding cancellation, I/O errors, or regex runtime failures. */
export async function runSearchRecipe(
  recipe: SearchRecipe,
  cwd: string,
  signal?: AbortSignal,
  environment?: SearchEnvironment,
  observe?: (
    mode: SearchFallback["mode"] | undefined,
    snapshot: () => TextSearchBackendResult["matches"],
  ) => void,
): Promise<
  TextSearchBackendResult & {
    readonly query: string;
    readonly notices: readonly string[];
    readonly fallback?: SearchFallback["mode"];
  }
> {
  let query = recipe.query;
  let selectedFallback: SearchFallback["mode"] | undefined;
  const observerFor = (
    mode: SearchFallback["mode"] | undefined,
  ): ObserveSearchMatches | undefined => observe && ((snapshot) => observe(mode, snapshot));
  let result = await searchText(
    recipe,
    cwd,
    signal,
    undefined,
    environment,
    observerFor(undefined),
  );
  observe?.(undefined, () => result.matches);
  const notices: string[] = [];
  for (const fallback of recipe.fallbacks ?? []) {
    if (result.matches.length > 0 || !result.complete) break;
    signal?.throwIfAborted();
    try {
      const next = await searchText(
        { ...recipe, query: fallback.query, regex: true, condition: fallback.condition },
        cwd,
        signal,
        undefined,
        environment,
        observerFor(fallback.mode),
      );
      result = next;
      observe?.(fallback.mode, () => next.matches);
      query = fallback.query;
      selectedFallback = fallback.mode;
      notices.push(fallbackNotice(fallback.mode));
    } catch (error) {
      if (fallback.mode !== "regex" || !isRegexSyntaxError(error) || signal?.aborted) throw error;
      notices.push("Search fallback: invalid regex skipped; literal search found no matches.");
    }
  }
  if (result.unreadable !== undefined) notices.push(unreadableNotice(result.unreadable, cwd));
  return {
    ...result,
    query,
    notices,
    ...(selectedFallback === undefined ? {} : { fallback: selectedFallback }),
  };
}

/** Explain a selection made of separate terms, not one literal phrase. */
export function tokenSelectionWarning(
  recipe: SearchRecipe,
  selectedQuery: string,
  count: number,
  complete: boolean,
): string | undefined {
  const hint = wordHintRejection(recipe, selectedQuery, count);
  if (hint !== undefined) return hint;
  if (count === 0 || recipe.originalQuery === undefined) return undefined;
  const fallback = recipe.fallbacks?.find((step) => step.query === selectedQuery);
  const condition = fallback === undefined ? recipe.condition : fallback.condition;
  if (condition === undefined || condition.kind === "term") return undefined;
  const query = recipe.originalQuery;
  return `Search query ${JSON.stringify(query)} matched ${String(count)}${complete ? "" : "+"} separate tokens, not one phrase. Editing the whole result is unsafe; use an individual match as path, or use the result as path with that match as start (and the same match as end if needed). To find the exact text instead, put it in quotes.`;
}

/**
 * Why no match of the separate-word fallback can be edited. Those matches are words found anywhere,
 * not the query's text, so they serve only as location hints.
 */
export function wordHintRejection(
  recipe: SearchRecipe,
  selectedQuery: string,
  count: number,
): string | undefined {
  if (count === 0 || recipe.originalQuery === undefined) return undefined;
  const fallback = recipe.fallbacks?.find((step) => step.query === selectedQuery);
  if (fallback?.mode !== "words") return undefined;
  return `No exact text ${JSON.stringify(recipe.originalQuery)} was found; these matches are its separate words, shown as read-only location hints. Read a location, then edit through a Read anchor or search for the exact current text.`;
}
/** Tell the agent how a broadened search may be used, because its matches can differ from the query. */
export function fallbackNotice(mode: SearchFallback["mode"]): string {
  return mode === "regex"
    ? "Search fallback: no literal matches; tried the query as regex. Use these matches as location hints; refine the query before editing."
    : "Search fallback: no exact text; tried separate words.";
}

/** Name the operators when a query was parsed as a Boolean expression. */
export function booleanQueryNotice(recipe: SearchRecipe): string | undefined {
  return recipe.condition === undefined || recipe.condition.kind === "term"
    ? undefined
    : "Boolean query: uppercase AND, OR, NOT, || and a spaced | are operators, and quotes group a phrase. To find text that contains an operator, put that text in quotes.";
}

function isRegexSyntaxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /regex parse error:|PCRE2: error compiling pattern/iu.test(error.message)
  );
}
