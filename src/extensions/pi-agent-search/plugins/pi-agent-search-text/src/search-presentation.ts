import type { TextSearchMatch } from "#src/search-session.js";

export interface SearchPresentationGroup {
  readonly text: string;
  readonly matchCount: number;
  /** First match with this line text, so the summary can show a usable reference. */
  readonly first: TextSearchMatch;
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

/** Shares one item budget between complete small files, compact summaries and groups. A summary item includes its first group. */
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
  let itemCount = matches.length;
  const noisiestFirst = [...bySource].sort(
    ([leftSource, left], [rightSource, right]) =>
      right.length - left.length || leftSource.localeCompare(rightSource),
  );
  for (const [source, sourceMatches] of noisiestFirst) {
    if (itemCount <= detailBudget) break;
    compacted.add(source);
    itemCount -= sourceMatches.length - 1;
  }

  const files: SearchPresentationFile[] = [];
  let remaining = detailBudget;
  // Keep complete small files before spending the remaining budget on noisy summaries.
  const ordered = [...bySource].sort(
    ([left], [right]) =>
      Number(compacted.has(left)) - Number(compacted.has(right)) || left.localeCompare(right),
  );
  for (const [source, sourceMatches] of ordered) {
    if (!compacted.has(source)) {
      if (sourceMatches.length > remaining) continue;
      files.push({ kind: "detailed", source, matches: sourceMatches });
      remaining -= sourceMatches.length;
      continue;
    }
    if (remaining < 1) continue;
    remaining--;
    const counts = new Map<string, { matchCount: number; first: TextSearchMatch }>();
    for (const match of sourceMatches) {
      const group = counts.get(match.lineText);
      if (group === undefined) counts.set(match.lineText, { matchCount: 1, first: match });
      else group.matchCount++;
    }
    const sorted = [...counts]
      .sort(
        ([leftText, left], [rightText, right]) =>
          right.matchCount - left.matchCount || leftText.localeCompare(rightText),
      )
      .map(([text, group]) => ({ text, ...group }));
    // The summary item always shows its most frequent line; a single file spends the rest on more lines.
    const extra = bySource.size === 1 ? Math.min(remaining, sorted.length - 1) : 0;
    const groups = sorted.slice(0, 1 + extra);
    remaining -= extra;
    files.push({
      kind: "compacted",
      source,
      matchCount: sourceMatches.length,
      uniqueLineCount: counts.size,
      groups,
    });
  }
  files.sort((left, right) => left.source.localeCompare(right.source));
  return { files };
}
