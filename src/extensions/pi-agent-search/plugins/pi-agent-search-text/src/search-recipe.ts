import type { SearchEnvironment } from "pi-agent-search/api/search";
import {
  searchText,
  type TextSearchRequest,
  type TextSearchBackendResult,
} from "#src/search-backend.js";
import {
  compileSearchQuery,
  compileSearchFallbackQuery,
  compileSearchCondition,
  type SearchCondition,
} from "#src/search-query.js";

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
  if (words !== undefined && words !== query && words !== regex) {
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
      notices.push(
        fallback.mode === "regex"
          ? "Search fallback: no literal matches; tried unquoted terms as regex."
          : "Search fallback: no matches in earlier modes; tried separate words. Use these matches as location hints; refine the query before editing.",
      );
    } catch (error) {
      if (fallback.mode !== "regex" || !isRegexSyntaxError(error) || signal?.aborted) throw error;
      notices.push("Search fallback: invalid regex skipped; literal search found no matches.");
    }
  }
  return { ...result, query, notices };
}

function isRegexSyntaxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /regex parse error:|PCRE2: error compiling pattern/iu.test(error.message)
  );
}
