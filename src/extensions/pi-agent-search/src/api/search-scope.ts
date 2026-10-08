import type { ResolvedResultTargets } from "pi-agent-resource";
import type { SearchSelectionMatch } from "./search.js";

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
