import { requiredValue } from "../../../../../utils/required-value.js";
import { diffChars, diffWordsWithSpace, lineDiff } from "diff";

import type { TextMutationPreviewRange } from "pi-agent-text-editor/api/mutation-preview";

export const DIFF_CONTEXT_LINES = 2;

export type DiffRowKind = "context" | "modified" | "added" | "removed" | "omitted";

export interface DiffTextRange {
  readonly from: number;
  readonly to: number;
}

export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly text: string;
  readonly beforeLine?: number;
  readonly afterLine?: number;
  readonly changed: boolean;
  readonly addedRanges?: readonly DiffTextRange[];
  readonly omitted?: number;
}

export interface DiffModel {
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly modified: number;
  readonly removed: number;
  readonly focusRow: number;
}

interface NumberedLine {
  readonly text: string;
  readonly line: number;
}

interface HunkWindow {
  readonly start: number;
  readonly end: number;
}

const LINE_PAIR_THRESHOLD = 0.5;

const NON_SEMANTIC_TOKENS = new Set([
  "async",
  "boolean",
  "const",
  "export",
  "false",
  "function",
  "interface",
  "let",
  "new",
  "null",
  "number",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "static",
  "string",
  "true",
  "type",
  "undefined",
  "var",
]);

export interface DiffModelOptions {
  readonly beforeLineOffset?: number;
  readonly afterLineOffset?: number;
  readonly project?: boolean;
  readonly focusAfterLine?: number;
}

export function createDiffModel(
  beforeContent: string,
  afterContent: string,
  ranges: readonly TextMutationPreviewRange[] = [],
  options: DiffModelOptions = {},
): DiffModel {
  const fullRows = createSemanticRows(
    beforeContent,
    afterContent,
    (options.beforeLineOffset ?? 0) + 1,
    (options.afterLineOffset ?? 0) + 1,
  );
  const rows = options.project === false ? fullRows : projectHunks(fullRows);
  const latestAfterLine =
    options.focusAfterLine ??
    (ranges.length === 0
      ? undefined
      : lineAtOffset(afterContent, requiredValue(ranges.at(-1)).to) +
        (options.afterLineOffset ?? 0));

  return {
    rows,
    added: fullRows.filter(({ kind }) => kind === "added").length,
    modified: fullRows.filter(({ kind }) => kind === "modified").length,
    removed: fullRows.filter(({ kind }) => kind === "removed").length,
    focusRow: findFocusRow(rows, latestAfterLine),
  };
}

function createSemanticRows(
  beforeContent: string,
  afterContent: string,
  beforeStartLine = 1,
  afterStartLine = 1,
): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  const parts =
    lineDiff.diff(beforeContent, afterContent, {
      comparator: sameLineIgnoringEdgeWhitespace,
      timeout: 100,
      maxEditLength: 20_000,
    }) ?? [];
  let beforeLine = beforeStartLine;
  let afterLine = afterStartLine;

  for (let index = 0; index < parts.length;) {
    const part = requiredValue(parts[index]);

    if (!part.added && !part.removed) {
      for (const text of splitPart(part.value)) {
        rows.push({
          kind: "context",
          text,
          beforeLine: beforeLine++,
          afterLine: afterLine++,
          changed: false,
        });
      }

      index++;

      continue;
    }

    const removed: NumberedLine[] = [];
    const added: NumberedLine[] = [];

    while (
      index < parts.length &&
      (requiredValue(parts[index]).added || requiredValue(parts[index]).removed)
    ) {
      const changedPart = requiredValue(parts[index]);

      if (changedPart.removed) {
        for (const text of splitPart(changedPart.value)) {
          removed.push({ text, line: beforeLine++ });
        }
      } else {
        for (const text of splitPart(changedPart.value)) {
          added.push({ text, line: afterLine++ });
        }
      }

      index++;
    }

    rows.push(...alignChangedLines(removed, added));
  }

  return rows;
}

function sameLineIgnoringEdgeWhitespace(before: unknown, after: unknown): boolean {
  return (
    typeof before === "string" &&
    typeof after === "string" &&
    normalizedLineToken(before) === normalizedLineToken(after)
  );
}

function normalizedLineToken(value: string): string {
  const newline = value.endsWith("\r\n") ? "\r\n" : value.endsWith("\n") ? "\n" : "";
  return value.slice(0, value.length - newline.length).trim() + newline;
}

function scoreAt(scores: readonly (readonly number[])[], row: number, column: number): number {
  const score = scores[row]?.[column];
  if (score === undefined) {
    throw new RangeError(`Score [${row}, ${column}] is outside the alignment matrix.`);
  }
  return score;
}

function alignChangedLines(
  removed: readonly NumberedLine[],
  added: readonly NumberedLine[],
): readonly DiffRow[] {
  if (removed.length === 1 && added.length === 1) {
    return [modifiedRow(requiredValue(removed[0]), requiredValue(added[0]))];
  }

  const scores = Array.from({ length: removed.length + 1 }, () =>
    Array.from<number>({ length: added.length + 1 }).fill(0),
  );

  for (let oldIndex = 1; oldIndex <= removed.length; oldIndex++) {
    for (let newIndex = 1; newIndex <= added.length; newIndex++) {
      const similarity = lineSimilarity(
        requiredValue(removed[oldIndex - 1]).text,
        requiredValue(added[newIndex - 1]).text,
      );
      const pair =
        similarity >= LINE_PAIR_THRESHOLD
          ? scoreAt(scores, oldIndex - 1, newIndex - 1) + similarity
          : Number.NEGATIVE_INFINITY;
      requiredValue(scores[oldIndex])[newIndex] = Math.max(
        scoreAt(scores, oldIndex - 1, newIndex),
        scoreAt(scores, oldIndex, newIndex - 1),
        pair,
      );
    }
  }

  const reversed: DiffRow[] = [];
  let oldIndex = removed.length;
  let newIndex = added.length;

  while (oldIndex > 0 || newIndex > 0) {
    const similarity =
      oldIndex > 0 && newIndex > 0
        ? lineSimilarity(
            requiredValue(removed[oldIndex - 1]).text,
            requiredValue(added[newIndex - 1]).text,
          )
        : 0;
    const pairScore =
      oldIndex > 0 && newIndex > 0 && similarity >= LINE_PAIR_THRESHOLD
        ? scoreAt(scores, oldIndex - 1, newIndex - 1) + similarity
        : Number.NEGATIVE_INFINITY;

    if (pairScore === scoreAt(scores, oldIndex, newIndex)) {
      reversed.push(
        modifiedRow(requiredValue(removed[oldIndex - 1]), requiredValue(added[newIndex - 1])),
      );
      oldIndex--;
      newIndex--;
    } else if (
      newIndex > 0 &&
      scoreAt(scores, oldIndex, newIndex - 1) >=
        (oldIndex > 0 ? scoreAt(scores, oldIndex - 1, newIndex) : Number.NEGATIVE_INFINITY)
    ) {
      const line = requiredValue(added[newIndex - 1]);
      reversed.push({ kind: "added", text: line.text, afterLine: line.line, changed: true });
      newIndex--;
    } else {
      const line = requiredValue(removed[oldIndex - 1]);
      reversed.push({ kind: "removed", text: line.text, beforeLine: line.line, changed: true });
      oldIndex--;
    }
  }

  return reversed.reverse();
}

function modifiedRow(before: NumberedLine, after: NumberedLine): DiffRow {
  return {
    kind: "modified",
    text: after.text,
    beforeLine: before.line,
    afterLine: after.line,
    changed: true,
    addedRanges: changedTextRanges(before.text, after.text),
  };
}

function changedTextRanges(before: string, after: string): readonly DiffTextRange[] {
  const ranges: DiffTextRange[] = [];
  const parts =
    diffWordsWithSpace(before, after, { timeout: 50, maxEditLength: 5_000 }) ??
    diffChars(before, after);
  let offset = 0;

  for (const part of parts) {
    if (part.removed) {
      continue;
    }

    if (part.added && part.value.length > 0) {
      let from = offset;
      let to = offset + part.value.length;

      if (from === 0) {
        from += part.value.length - part.value.trimStart().length;
      }

      if (to === after.length) {
        to -= part.value.length - part.value.trimEnd().length;
      }

      if (from < to) {
        ranges.push({ from, to });
      }
    }

    offset += part.value.length;
  }

  return ranges;
}

function lineSimilarity(before: string, after: string): number {
  const characterScore = characterSimilarity(before, after);
  const beforeTokens = semanticTokens(before);
  const afterTokens = semanticTokens(after);

  if (beforeTokens.length === 0 && afterTokens.length === 0) {
    return characterScore;
  }

  const tokenScore =
    (directionalTokenSimilarity(beforeTokens, afterTokens) +
      directionalTokenSimilarity(afterTokens, beforeTokens)) /
    2;
  return characterScore * 0.35 + tokenScore * 0.65;
}

function semanticTokens(line: string): readonly string[] {
  return (line.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []).filter(
    (token) => !NON_SEMANTIC_TOKENS.has(token),
  );
}

function directionalTokenSimilarity(source: readonly string[], target: readonly string[]): number {
  if (source.length === 0 || target.length === 0) {
    return 0;
  }

  return (
    source.reduce(
      (total, token) =>
        total + Math.max(...target.map((candidate) => characterSimilarity(token, candidate))),
      0,
    ) / source.length
  );
}

function characterSimilarity(before: string, after: string): number {
  const longest = Math.max(before.length, after.length);

  if (longest === 0) {
    return 1;
  }

  const unchanged =
    diffChars(before, after, { timeout: 25, maxEditLength: 2_000 })
      ?.filter((part) => !part.added && !part.removed)
      .reduce((length, part) => length + part.value.length, 0) ?? 0;
  return unchanged / longest;
}

function projectHunks(rows: readonly DiffRow[]): readonly DiffRow[] {
  const windows: HunkWindow[] = [];

  for (let index = 0; index < rows.length; index++) {
    if (!requiredValue(rows[index]).changed) {
      continue;
    }

    const changedStart = index;

    while (index + 1 < rows.length && requiredValue(rows[index + 1]).changed) {
      index++;
    }

    const next = {
      start: Math.max(0, changedStart - DIFF_CONTEXT_LINES),
      end: Math.min(rows.length - 1, index + DIFF_CONTEXT_LINES),
    };
    const previous = windows.at(-1);

    if (previous !== undefined && next.start <= previous.end + 1) {
      windows[windows.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, next.end),
      };
    } else {
      windows.push(next);
    }
  }

  return windows.flatMap((window, index) => {
    const previous = windows[index - 1];
    const omitted = previous === undefined ? [] : [omittedRow(window.start - previous.end - 1)];
    return [...omitted, ...rows.slice(window.start, window.end + 1)];
  });
}

function omittedRow(count: number): DiffRow {
  return { kind: "omitted", text: "", changed: false, omitted: count };
}

function splitPart(value: string): readonly string[] {
  if (value.length === 0) {
    return [];
  }

  const normalized = value.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");

  if (normalized.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < Math.min(offset, content.length); index++) {
    if (content[index] === "\n") {
      line++;
    }
  }

  return line;
}

function findFocusRow(rows: readonly DiffRow[], latestAfterLine: number | undefined): number {
  if (latestAfterLine !== undefined) {
    const exact = rows.findLastIndex(
      (row) => row.afterLine !== undefined && row.afterLine <= latestAfterLine && row.changed,
    );

    if (exact !== -1) {
      return exact;
    }
  }

  return Math.max(
    0,
    rows.findLastIndex((row) => row.changed),
  );
}
