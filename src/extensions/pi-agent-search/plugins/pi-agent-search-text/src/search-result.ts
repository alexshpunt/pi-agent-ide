import path from "node:path";
import { pathToFileURL } from "node:url";

import type { TextSearchMatch } from "#src/search-session.js";

export interface SearchResultRange {
  readonly from: number;
  readonly to: number;
}

export interface SearchResultLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly matchCount: number;
  readonly ranges: readonly SearchResultRange[];
}

export interface SearchResultFile {
  readonly path: string;
  readonly link: string;
  readonly matchCount: number;
  readonly lines: readonly SearchResultLine[];
}

export interface SearchToolDetails {
  readonly sessionId?: string;
  readonly query: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly complete: boolean;
  readonly files: readonly SearchResultFile[];
}

interface MutableSearchResultLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly ranges: SearchResultRange[];
}

export function createSearchToolDetails(
  query: string,
  matches: readonly TextSearchMatch[],
  complete: boolean,
  cwd: string,
  sessionId?: string,
): SearchToolDetails {
  const matchesBySource = new Map<string, TextSearchMatch[]>();

  for (const match of matches) {
    const source = path.resolve(match.source);
    matchesBySource.set(source, [...(matchesBySource.get(source) ?? []), match]);
  }

  const files = [...matchesBySource]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, sourceMatches]) => createSearchResultFile(source, sourceMatches, cwd));

  return {
    ...(sessionId !== undefined && { sessionId }),
    query,
    matchCount: matches.length,
    fileCount: files.length,
    complete,
    files,
  };
}

export function isSearchToolDetails(value: unknown): value is SearchToolDetails {
  if (
    !isRecord(value) ||
    typeof value.query !== "string" ||
    !isCount(value.matchCount) ||
    !isCount(value.fileCount) ||
    typeof value.complete !== "boolean" ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(isSearchResultFile)
  ) {
    return false;
  }

  const files = value.files as readonly SearchResultFile[];
  return (
    value.fileCount === files.length &&
    value.matchCount === files.reduce((count, file) => count + file.matchCount, 0)
  );
}

function createSearchResultFile(
  source: string,
  matches: readonly TextSearchMatch[],
  cwd: string,
): SearchResultFile {
  const lines = new Map<number, MutableSearchResultLine>();

  for (const match of matches) {
    const current = lines.get(match.lineNumber);

    if (current !== undefined && current.text !== match.lineText) {
      throw new Error(
        `Search results disagree about line ${String(match.lineNumber)} in ${source}.`,
      );
    }

    const line = current ?? { lineNumber: match.lineNumber, text: match.lineText, ranges: [] };
    line.ranges.push({ from: match.startColumn, to: match.endColumn });
    lines.set(match.lineNumber, line);
  }

  const resultLines = [...lines.values()]
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .map((line): SearchResultLine => {
      const ranges = [...line.ranges].sort(
        (left, right) => left.from - right.from || left.to - right.to,
      );
      return {
        lineNumber: line.lineNumber,
        text: line.text,
        matchCount: ranges.length,
        ranges,
      };
    });

  return {
    path: displaySource(source, cwd),
    link: pathToFileURL(source).href,
    matchCount: matches.length,
    lines: resultLines,
  };
}

function isSearchResultFile(value: unknown): value is SearchResultFile {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.link !== "string" ||
    !isCount(value.matchCount) ||
    !Array.isArray(value.lines) ||
    !value.lines.every(isSearchResultLine)
  ) {
    return false;
  }

  return (
    value.matchCount ===
    (value.lines as readonly SearchResultLine[]).reduce((count, line) => count + line.matchCount, 0)
  );
}

function isSearchResultLine(value: unknown): value is SearchResultLine {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.lineNumber) &&
    (value.lineNumber as number) >= 1 &&
    typeof value.text === "string" &&
    isCount(value.matchCount) &&
    Array.isArray(value.ranges) &&
    value.ranges.length === value.matchCount &&
    value.ranges.every((range) => isSearchResultRange(range, value.text as string))
  );
}

function isSearchResultRange(value: unknown, text: string): value is SearchResultRange {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.from) &&
    Number.isSafeInteger(value.to) &&
    (value.from as number) >= 0 &&
    (value.to as number) > (value.from as number) &&
    (value.to as number) <= text.length
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function displaySource(source: string, cwd: string): string {
  const relative = path.relative(cwd, source);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : source;
}
