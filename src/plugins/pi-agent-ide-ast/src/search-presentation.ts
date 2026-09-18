import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  SearchResultFile,
  SearchResultLine,
  SearchResultRange,
  SearchToolDetails,
} from "pi-agent-search-text/result";

export interface AstSearchPresentationMatch {
  readonly file: string;
  readonly lines: string;
  readonly range: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

/** Build ordinary grouped search presentation data without changing AST selection details. */
export function createAstSearchPresentation(
  query: string,
  matches: readonly AstSearchPresentationMatch[],
  complete: boolean,
  cwd: string,
  sessionId: string,
): SearchToolDetails {
  const grouped = new Map<string, AstSearchPresentationMatch[]>();
  for (const match of matches) {
    const current = grouped.get(match.file) ?? [];
    current.push(match);
    grouped.set(match.file, current);
  }
  const files = [...grouped.entries()].map(([file, fileMatches]) =>
    createFilePresentation(file, fileMatches, cwd),
  );
  return {
    sessionId,
    query,
    matchCount: matches.length,
    fileCount: files.length,
    complete,
    files,
  };
}

function createFilePresentation(
  file: string,
  matches: readonly AstSearchPresentationMatch[],
  cwd: string,
): SearchResultFile {
  const lines = new Map<
    number,
    { text: string; ranges: SearchResultRange[]; logicalMatchIds: string[] }
  >();
  matches.forEach((match, matchIndex) => {
    const texts = match.lines.replace(/\r/gu, "").split("\n");
    if (texts.at(-1) === "") texts.pop();
    const logicalId = `${file}:${String(matchIndex)}`;
    texts.forEach((text, index) => {
      const lineNumber = match.range.start.line + index + 1;
      const range = highlightedRange(match, text, index, texts.length);
      if (range === undefined) return;
      const current = lines.get(lineNumber) ?? { text, ranges: [], logicalMatchIds: [] };
      current.ranges.push(range);
      current.logicalMatchIds.push(logicalId);
      lines.set(lineNumber, current);
    });
  });
  const resultLines: SearchResultLine[] = [...lines.entries()]
    .sort(([left], [right]) => left - right)
    .map(([lineNumber, line]) => {
      const ranges = mergeRanges(line.ranges);
      return {
        lineNumber,
        text: line.text,
        matchCount: ranges.length,
        ranges,
        logicalMatchIds: [...new Set(line.logicalMatchIds)],
      };
    });
  const source = path.resolve(cwd, file);
  return {
    path: path.relative(cwd, source),
    link: pathToFileURL(source).href,
    matchCount: matches.length,
    lines: resultLines,
  };
}

function highlightedRange(
  match: AstSearchPresentationMatch,
  text: string,
  index: number,
  lineCount: number,
): SearchResultRange | undefined {
  const first = index === 0;
  const last = index === lineCount - 1;
  const from = first ? match.range.start.column : 0;
  const to = last ? match.range.end.column : text.length;
  if (to <= from) return undefined;
  return { from: Math.min(from, text.length), to: Math.min(to, text.length) };
}

function mergeRanges(ranges: readonly SearchResultRange[]): SearchResultRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SearchResultRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.from > previous.to) {
      merged.push(range);
    } else {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    }
  }
  return merged;
}
