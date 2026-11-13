import type { SearchEnvironment } from "pi-agent-search/api/search";
import type { UnreadablePaths } from "#src/ripgrep.ts";
import { displaySource } from "#src/search-result.ts";
import {
  searchText,
  type TextSearchRequest,
  type TextSearchBackendResult,
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
): Promise<
  TextSearchBackendResult & { readonly query: string; readonly notices: readonly string[] }
> {
  let query = recipe.query;
  let result = await searchText(recipe, cwd, signal, undefined, environment);
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
      );
      result = next;
      query = fallback.query;
      notices.push(fallbackNotice(fallback.mode));
    } catch (error) {
      if (fallback.mode !== "regex" || !isRegexSyntaxError(error) || signal?.aborted) throw error;
      notices.push("Search fallback: invalid regex skipped; literal search found no matches.");
    }
  }
  if (result.unreadable !== undefined) notices.push(unreadableNotice(result.unreadable, cwd));
  return { ...result, query, notices };
}

/** Summarize in one line the paths a search could not read, so they never replace its matches. */
function unreadableNotice(unreadable: UnreadablePaths, cwd: string): string {
  const paths = unreadable.count === 1 ? "1 path" : `${unreadable.count} paths`;
  const { path, error } = unreadable.first;
  return `Search notice: could not read ${paths}, so matches in them are missing. First: ${displaySource(path, cwd)}: ${error}`;
}

/** Tell the agent how a broadened search may be used, because its matches can differ from the query. */
export function fallbackNotice(mode: SearchFallback["mode"]): string {
  const hint = "Use these matches as location hints; refine the query before editing.";
  return mode === "regex"
    ? `Search fallback: no literal matches; tried unquoted terms as regex. ${hint}`
    : `Search fallback: no matches in earlier modes; tried separate words. ${hint}`;
}

/** Name the operators when a plain query was parsed as a Boolean expression. */
export function booleanQueryNotice(recipe: SearchRecipe): string | undefined {
  return recipe.condition === undefined || recipe.condition.kind === "term"
    ? undefined
    : "Boolean query: uppercase AND, OR, NOT, || and a spaced | are operators. Quote text to search for it literally.";
}

function isRegexSyntaxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /regex parse error:|PCRE2: error compiling pattern/iu.test(error.message)
  );
}
