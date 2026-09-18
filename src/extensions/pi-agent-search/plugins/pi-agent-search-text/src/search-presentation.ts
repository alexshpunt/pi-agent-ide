import type { TextSearchMatch } from "#src/search-session.js";

export interface SearchPresentationGroup {
  readonly text: string;
  readonly matchCount: number;
}

export type SearchPresentationFile =
  | {
      readonly kind: "detailed";
      readonly source: string;
      readonly matches: readonly TextSearchMatch[];
    }
  | {
      readonly kind: "compacted";
      readonly source: string;
      readonly matchCount: number;
      readonly uniqueLineCount: number;
      readonly groups: readonly SearchPresentationGroup[];
    };

export interface SearchPresentation {
  readonly files: readonly SearchPresentationFile[];
}

/** Selects bounded search details while preserving complete low-volume files. */
export function planSearchPresentation(
  matches: readonly TextSearchMatch[],
  detailBudget: number,
): SearchPresentation {
  const bySource = new Map<string, TextSearchMatch[]>();
  for (const match of matches) {
    const sourceMatches = bySource.get(match.source) ?? [];
    sourceMatches.push(match);
    bySource.set(match.source, sourceMatches);
  }

  const compacted = new Set<string>();
  let detailedCount = matches.length;
  const noisiestFirst = [...bySource].sort(
    ([leftSource, left], [rightSource, right]) =>
      right.length - left.length || leftSource.localeCompare(rightSource),
  );
  for (const [source, sourceMatches] of noisiestFirst) {
    if (detailedCount <= detailBudget) break;
    compacted.add(source);
    detailedCount -= sourceMatches.length;
  }

  const files = [...bySource]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, sourceMatches]): SearchPresentationFile => {
      if (!compacted.has(source)) {
        return { kind: "detailed", source, matches: sourceMatches };
      }

      const counts = new Map<string, number>();
      for (const match of sourceMatches) {
        counts.set(match.lineText, (counts.get(match.lineText) ?? 0) + 1);
      }
      return {
        kind: "compacted",
        source,
        matchCount: sourceMatches.length,
        uniqueLineCount: counts.size,
        groups:
          bySource.size === 1
            ? [...counts]
                .sort(
                  ([leftText, leftCount], [rightText, rightCount]) =>
                    rightCount - leftCount || leftText.localeCompare(rightText),
                )
                .slice(0, detailBudget)
                .map(([text, matchCount]) => ({ text, matchCount }))
            : [],
      };
    });

  return { files };
}
