import { verifyResultTargets, type ResolvedResultTargets } from "pi-agent-resource";
import type { SearchContext, SearchSelectionMatch } from "./search.ts";

/**
 * The result scope of a search could not be found in the current text any more. `code` lets a
 * refresh report it without matching on the message.
 */
export class SearchScopeChangedError extends Error {
  readonly code = "SCOPE_CHANGED";
  public constructor(reason: string, options?: ErrorOptions) {
    super(
      `The scope this search ran in is no longer in its file (${reason}). Run the search again from a current Read or Search result.`,
      options,
    );
    this.name = "SearchScopeChangedError";
  }
}

/**
 * The result scope as the text of its sources is now. A context that can resolve it again does so,
 * moving regions whose lines changed; any other scope must still match its sources exactly.
 */
export async function currentScope(
  context: SearchContext,
  signal?: AbortSignal,
): Promise<ResolvedResultTargets | undefined> {
  if (context.scope === undefined) return undefined;
  try {
    if (context.rescope !== undefined) return await context.rescope(signal);
    await verifyResultTargets(context.scope, signal);
    return context.scope;
  } catch (error) {
    if (signal?.aborted === true || error instanceof SearchScopeChangedError) throw error;
    throw new SearchScopeChangedError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** Keep a provider match only when one declared region wholly contains its exact range. */
export function containsSearchMatch(
  scope: ResolvedResultTargets,
  match: SearchSelectionMatch,
): boolean {
  return scope.targets.some(
    (target) =>
      target.source === match.source &&
      target.ranges.some(
        (range) =>
          (range.start.lineNumber < match.lineNumber ||
            (range.start.lineNumber === match.lineNumber &&
              range.start.column <= match.startColumn)) &&
          (range.end.lineNumber > (match.endLineNumber ?? match.lineNumber) ||
            (range.end.lineNumber === (match.endLineNumber ?? match.lineNumber) &&
              range.end.column >= match.endColumn)),
      ),
  );
}
