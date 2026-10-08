import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import { createTextDocument } from "pi-agent-text";
import { searchTextContent } from "#src/search-backend.js";
import type { TextSearchBackendResult } from "#src/search-backend.js";
import type { SearchRecipe } from "#src/search-recipe.js";
import type { TextSearchMatch } from "#src/search-session.js";

/** Run each real source range separately; gaps and neighboring text are never searched. */
export async function runScopedSearch(
  recipe: SearchRecipe,
  scope: ResolvedResultTargets,
  cwd: string,
  signal?: AbortSignal,
): Promise<
  TextSearchBackendResult & { readonly query: string; readonly notices: readonly string[] }
> {
  if (recipe.include !== undefined || recipe.exclude !== undefined)
    throw new Error(
      "Include/exclude globs are unsupported for result scopes; filter the target array instead.",
    );
  const search = async (
    query: string,
    condition = recipe.condition,
  ): Promise<TextSearchBackendResult> => {
    const matches: TextSearchMatch[] = [];
    const seen = new Set<string>();
    for (const target of scope.targets) {
      signal?.throwIfAborted();
      await verifyResultTargets({ targets: [target], complete: scope.complete }, signal);
      const document = createTextDocument(target.source, target.expectedContent);
      const starts = [0];
      for (const line of document.lines)
        starts.push((starts.at(-1) ?? 0) + line.content.length + line.lineEnding.length);
      for (const range of target.ranges) {
        const from =
          (starts[range.start.lineNumber - 1] ?? document.content.length) + range.start.column;
        const to = (starts[range.end.lineNumber - 1] ?? document.content.length) + range.end.column;
        const result = await searchTextContent(
          { ...recipe, query, condition },
          document.content.slice(from, to),
          cwd.includes("://") ? process.cwd() : cwd,
          signal,
        );
        for (const match of result.matches) {
          const lineNumber = range.start.lineNumber + match.lineNumber - 1;
          const shift = match.lineNumber === 1 ? range.start.column : 0;
          const mapped: TextSearchMatch = {
            ...match,
            source: target.source,
            lineNumber,
            startColumn: match.startColumn + shift,
            endColumn: match.endColumn + shift,
            lineText: document.lines[lineNumber - 1]?.content ?? "",
          };
          const key = JSON.stringify([
            mapped.source,
            lineNumber,
            mapped.startColumn,
            mapped.endColumn,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push(mapped);
        }
      }
    }
    matches.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.lineNumber - right.lineNumber ||
        left.startColumn - right.startColumn ||
        left.endColumn - right.endColumn,
    );
    return { matches, complete: scope.complete };
  };
  let query = recipe.query;
  let result = await search(query);
  const notices: string[] = [];
  for (const fallback of recipe.fallbacks ?? []) {
    if (result.matches.length > 0 || !result.complete) break;
    try {
      result = await search(fallback.query, fallback.condition);
      query = fallback.query;
      notices.push(
        fallback.mode === "regex"
          ? "Search fallback: no literal matches; tried unquoted terms as regex."
          : "Search fallback: no matches in earlier modes; tried separate words. Use these matches as location hints; refine the query before editing.",
      );
    } catch (error) {
      if (
        signal?.aborted ||
        fallback.mode !== "regex" ||
        !(error instanceof Error) ||
        !/regex parse error:|PCRE2: error compiling pattern/iu.test(error.message)
      )
        throw error;
      notices.push("Search fallback: invalid regex skipped; literal search found no matches.");
    }
  }
  await verifyResultTargets(scope, signal);
  return { ...result, query, notices };
}
