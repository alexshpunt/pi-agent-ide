import { requiredValue } from "pi-agent-invariant";
import { diffArrays, diffChars } from "diff";

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
  /** Half-open UTF-16 ranges in the final line. */
  readonly addedRanges?: readonly DiffTextRange[];
  /** UTF-16 positions of pure deletions in the final line. */
  readonly deletedOffsets?: readonly number[];
  /** The line changed, but its inline comparison exhausted the preview budget. */
  readonly inlineUnavailable?: boolean;
  readonly omitted?: number;
}

export interface DiffModel {
  /** Changed rows excluded from this operation's local presentation. */
  readonly omittedChanges?: {
    readonly outside: number;
    readonly ambiguous: number;
    /** The line comparison exceeded its size or time limit; changed-row counts are unknown. */
    readonly unavailable?: boolean;
  };
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
const DIFF_BUDGET_MS = 100;
const MAX_ALIGNMENT_CELLS = 16_000;
const MAX_DIFF_CHARACTERS = 1_000_000;

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
  if (fullRows === undefined) {
    return {
      rows: [],
      added: 0,
      modified: 0,
      removed: 0,
      focusRow: 0,
      omittedChanges: { outside: 0, ambiguous: 0, unavailable: true },
    };
  }
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
): readonly DiffRow[] | undefined {
  if (beforeContent.length + afterContent.length > MAX_DIFF_CHARACTERS) return undefined;
  const deadline = performance.now() + DIFF_BUDGET_MS;
  const before = splitPart(beforeContent);
  const after = splitPart(afterContent);
  const rows: DiffRow[] = [];
  if (before.length === 0 || after.length === 0) {
    return [
      ...before.map((text, index): DiffRow => ({
        kind: "removed",
        text,
        beforeLine: beforeStartLine + index,
        changed: true,
      })),
      ...after.map((text, index): DiffRow => ({
        kind: "added",
        text,
        afterLine: afterStartLine + index,
        changed: true,
      })),
    ];
  }
  const changes = compareLines(before, after, deadline);
  if (changes === undefined || performance.now() >= deadline) return undefined;
  let oldIndex = 0;
  let newIndex = 0;
  const appendContext = (end: number) => {
    while (newIndex < end) {
      rows.push({
        kind: "context",
        text: requiredValue(after[newIndex]),
        beforeLine: beforeStartLine + oldIndex++,
        afterLine: afterStartLine + newIndex++,
        changed: false,
      });
    }
  };
  for (const change of changes) {
    appendContext(change.newStart);
    const removed = before
      .slice(change.oldStart, change.oldEnd)
      .map((text, index) => ({ text, line: beforeStartLine + oldIndex + index }));
    const added = after
      .slice(change.newStart, change.newEnd)
      .map((text, index) => ({ text, line: afterStartLine + newIndex + index }));
    const aligned = alignChangedLines(removed, added, deadline);
    // Detailed pairing is optional: the line comparison already identified this changed block.
    rows.push(
      ...(aligned ?? [
        ...removed.map(({ text, line }): DiffRow => ({
          kind: "removed",
          text,
          beforeLine: line,
          changed: true,
        })),
        ...added.map(({ text, line }): DiffRow => ({
          kind: "added",
          text,
          afterLine: line,
          changed: true,
        })),
      ]),
    );
    oldIndex += removed.length;
    newIndex += added.length;
  }
  appendContext(after.length);
  if (beforeContent.endsWith("\n") !== afterContent.endsWith("\n")) {
    const last = rows.at(-1);
    if (last?.kind === "context") {
      rows[rows.length - 1] = {
        ...last,
        kind: "modified",
        changed: true,
        addedRanges: [],
        deletedOffsets: beforeContent.endsWith("\n") ? [last.text.length] : [],
      };
    }
  }
  return rows;
}

/** Zero-based, end-exclusive line spans of a changed block. */
interface LineChange {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

/**
 * Changed line blocks, compared without edge whitespace, or undefined when the deadline passes.
 * The panel previews what the agent changed, so a fast minimal (Myers) diff of the lines between
 * identical edges is preferred over an alignment that is prettier but can miss the budget.
 */
function compareLines(
  before: readonly string[],
  after: readonly string[],
  deadline: number,
): readonly LineChange[] | undefined {
  const oldLines = before.map((line) => line.trim());
  const newLines = after.map((line) => line.trim());
  // With no shared trimmed line, the whole replacement block is already exact; a line diff
  // would only spend its worst case proving it.
  const oldSet = new Set(oldLines);
  if (!newLines.some((line) => oldSet.has(line))) {
    return [{ oldStart: 0, oldEnd: oldLines.length, newStart: 0, newEnd: newLines.length }];
  }

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  if (prefix === oldEnd || prefix === newEnd) {
    return prefix === oldEnd && prefix === newEnd
      ? []
      : [{ oldStart: prefix, oldEnd, newStart: prefix, newEnd }];
  }

  const timeout = deadline - performance.now();
  if (timeout <= 0) return undefined;
  const parts = diffArrays(oldLines.slice(prefix, oldEnd), newLines.slice(prefix, newEnd), {
    timeout,
  });
  if (parts === undefined) return undefined;
  const changes: LineChange[] = [];
  let oldLine = prefix;
  let newLine = prefix;
  let open: { readonly oldStart: number; readonly newStart: number } | undefined;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (open !== undefined) changes.push({ ...open, oldEnd: oldLine, newEnd: newLine });
      open = undefined;
      oldLine += part.count;
      newLine += part.count;
      continue;
    }
    open ??= { oldStart: oldLine, newStart: newLine };
    if (part.removed) oldLine += part.count;
    else newLine += part.count;
  }
  if (open !== undefined) changes.push({ ...open, oldEnd: oldLine, newEnd: newLine });
  return changes;
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
  deadline: number,
): readonly DiffRow[] | undefined {
  const similaritiesByText = new Map<string, Map<string, number>>();
  const compareCharacters = (before: string, after: string): number | undefined => {
    if (performance.now() >= deadline) return undefined;
    const cached = similaritiesByText.get(before)?.get(after);
    if (cached !== undefined) return cached;
    const score = characterSimilarity(before, after, deadline);
    if (score !== undefined) {
      let comparisons = similaritiesByText.get(before);
      if (comparisons === undefined) {
        comparisons = new Map();
        similaritiesByText.set(before, comparisons);
      }
      comparisons.set(after, score);
    }
    return score;
  };
  // Every candidate pair reads the tokens of both lines; tokenize each line once.
  const tokensByLine = new Map<string, readonly string[]>();
  const tokensOf = (line: string): readonly string[] => {
    let tokens = tokensByLine.get(line);
    if (tokens === undefined) {
      tokens = semanticTokens(line);
      tokensByLine.set(line, tokens);
    }
    return tokens;
  };
  // Preserve corresponding lines in a replacement block before trying every possible pair.
  if (removed.length > 1 && removed.length === added.length) {
    const paired: DiffRow[] = [];
    for (const [index, before] of removed.entries()) {
      const after = requiredValue(added[index]);
      const similarity = lineSimilarity(before.text, after.text, compareCharacters, tokensOf);
      if (similarity === undefined) return undefined;
      if (similarity < LINE_PAIR_THRESHOLD) break;
      const row = modifiedRow(before, after, deadline);
      if (row === undefined) return undefined;
      paired.push(row);
    }
    if (paired.length === removed.length) return paired;
  }
  if (removed.length === 1 && added.length === 1) {
    const row = modifiedRow(requiredValue(removed[0]), requiredValue(added[0]), deadline);
    return row === undefined ? undefined : [row];
  }

  if (removed.length * added.length > MAX_ALIGNMENT_CELLS) return undefined;
  const similarities = Array.from({ length: removed.length }, () =>
    Array<number>(added.length).fill(0),
  );
  const scores = Array.from({ length: removed.length + 1 }, () =>
    Array.from<number>({ length: added.length + 1 }).fill(0),
  );

  for (let oldIndex = 1; oldIndex <= removed.length; oldIndex++) {
    for (let newIndex = 1; newIndex <= added.length; newIndex++) {
      const similarity = lineSimilarity(
        requiredValue(removed[oldIndex - 1]).text,
        requiredValue(added[newIndex - 1]).text,
        compareCharacters,
        tokensOf,
      );
      if (similarity === undefined) return undefined;
      requiredValue(similarities[oldIndex - 1])[newIndex - 1] = similarity;
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
      oldIndex > 0 && newIndex > 0 ? scoreAt(similarities, oldIndex - 1, newIndex - 1) : 0;
    const pairScore =
      oldIndex > 0 && newIndex > 0 && similarity >= LINE_PAIR_THRESHOLD
        ? scoreAt(scores, oldIndex - 1, newIndex - 1) + similarity
        : Number.NEGATIVE_INFINITY;

    if (pairScore === scoreAt(scores, oldIndex, newIndex)) {
      const row = modifiedRow(
        requiredValue(removed[oldIndex - 1]),
        requiredValue(added[newIndex - 1]),
        deadline,
      );
      if (row === undefined) return undefined;
      reversed.push(row);
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

function modifiedRow(
  before: NumberedLine,
  after: NumberedLine,
  deadline: number,
): DiffRow | undefined {
  const changes = compareInlineText(before.text, after.text, deadline);
  if (changes === undefined) return undefined;
  return {
    kind: "modified",
    text: after.text,
    beforeLine: before.line,
    afterLine: after.line,
    changed: true,
    ...changes,
  };
}

/** Compare line contents without edge whitespace; offsets address the untrimmed final line. */
export function compareInlineText(
  before: string,
  after: string,
  deadline = performance.now() + DIFF_BUDGET_MS,
):
  | { readonly addedRanges: readonly DiffTextRange[]; readonly deletedOffsets: readonly number[] }
  | undefined {
  const timeout = deadline - performance.now();
  if (timeout <= 0 || before.length + after.length > MAX_DIFF_CHARACTERS) return undefined;
  const parts = diffChars(before.trim(), after.trim(), { timeout, maxEditLength: 5_000 });
  if (parts === undefined) return undefined;
  const addedRanges: DiffTextRange[] = [];
  const deletedOffsets: number[] = [];
  let offset = after.length - after.trimStart().length;
  for (let index = 0; index < parts.length; index++) {
    const part = requiredValue(parts[index]);
    if (part.removed) {
      if (!parts[index + 1]?.added) deletedOffsets.push(offset);
    } else {
      if (part.added) addedRanges.push({ from: offset, to: offset + part.value.length });
      offset += part.value.length;
    }
  }
  return { addedRanges, deletedOffsets };
}

type CharacterComparison = (before: string, after: string) => number | undefined;

function lineSimilarity(
  before: string,
  after: string,
  compareCharacters: CharacterComparison,
  tokensOf: (line: string) => readonly string[],
): number | undefined {
  const characterScore = compareCharacters(before, after);
  if (characterScore === undefined) return undefined;
  const beforeTokens = tokensOf(before);
  const afterTokens = tokensOf(after);

  if (beforeTokens.length === 0 && afterTokens.length === 0) {
    return characterScore;
  }

  const forward = directionalTokenSimilarity(beforeTokens, afterTokens, compareCharacters);
  const backward = directionalTokenSimilarity(afterTokens, beforeTokens, compareCharacters);
  if (forward === undefined || backward === undefined) return undefined;
  const tokenScore = (forward + backward) / 2;
  return characterScore * 0.35 + tokenScore * 0.65;
}

function semanticTokens(line: string): readonly string[] {
  return (line.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []).filter(
    (token) => !NON_SEMANTIC_TOKENS.has(token),
  );
}

function directionalTokenSimilarity(
  source: readonly string[],
  target: readonly string[],
  compareCharacters: CharacterComparison,
): number | undefined {
  if (source.length === 0 || target.length === 0) return 0;
  let total = 0;
  for (const token of source) {
    let greatest = 0;
    for (const candidate of target) {
      const score = compareCharacters(token, candidate);
      if (score === undefined) return undefined;
      greatest = Math.max(greatest, score);
    }
    total += greatest;
  }
  return total / source.length;
}

const SURROGATE = /[\uD800-\uDFFF]/u;
/** Largest bit-parallel LCS run, in word operations, that stays well inside the diff budget. */
const MAX_LCS_WORD_STEPS = 4_000_000;

/**
 * The unchanged share of a minimal character diff, as characterSimilarity defines it, computed
 * with a bit-parallel LCS. Undefined for surrogate pairs, whose code points need code-point
 * comparison, and for line pairs too long to finish in one uninterrupted step.
 */
function codeUnitSimilarity(before: string, after: string): number | undefined {
  const longest = Math.max(before.length, after.length);
  if (longest === 0 || before === after) return 1;
  if (SURROGATE.test(before) || SURROGATE.test(after)) return undefined;
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before.charCodeAt(start) === after.charCodeAt(start)
  )
    start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd--;
    afterEnd--;
  }
  const common = start + before.length - beforeEnd;
  const beforeLength = beforeEnd - start;
  const afterLength = afterEnd - start;
  if (beforeLength === 0 || afterLength === 0) return common / longest;
  const [long, longEnd, short, shortEnd] =
    afterLength <= beforeLength
      ? [before, beforeEnd, after, afterEnd]
      : [after, afterEnd, before, beforeEnd];
  const shortLength = shortEnd - start;
  if ((longEnd - start) * Math.ceil(shortLength / 32) > MAX_LCS_WORD_STEPS) return undefined;
  return (
    (common + longestCommonSubsequence(long, start, longEnd, short, start, shortEnd)) / longest
  );
}

/**
 * LCS length of two UTF-16 ranges with Hyyrö's bit-parallel algorithm: one pass over `left`,
 * 32 positions of `right` per word operation.
 */
function longestCommonSubsequence(
  left: string,
  leftStart: number,
  leftEnd: number,
  right: string,
  rightStart: number,
  rightEnd: number,
): number {
  const length = rightEnd - rightStart;
  const words = Math.ceil(length / 32);
  const masks = new Map<number, Uint32Array>();
  for (let index = 0; index < length; index++) {
    const code = right.charCodeAt(rightStart + index);
    let mask = masks.get(code);
    if (mask === undefined) {
      mask = new Uint32Array(words);
      masks.set(code, mask);
    }
    mask[index >>> 5] = requiredValue(mask[index >>> 5]) | (1 << (index & 31));
  }
  // Set bits mark positions of `right` not yet matched.
  const row = new Uint32Array(words).fill(0xff_ff_ff_ff);
  for (let index = leftStart; index < leftEnd; index++) {
    const mask = masks.get(left.charCodeAt(index));
    if (mask === undefined) continue;
    let carry = 0;
    for (let word = 0; word < words; word++) {
      const value = requiredValue(row[word]);
      const matched = (value & requiredValue(mask[word])) >>> 0;
      const sum = value + matched + carry;
      carry = sum > 0xff_ff_ff_ff ? 1 : 0;
      row[word] = ((sum >>> 0) | (value ^ matched)) >>> 0;
    }
  }
  let unmatched = 0;
  for (let word = 0; word < words; word++) {
    const tail = length - word * 32;
    let value = requiredValue(row[word]);
    if (tail < 32) value &= (1 << tail) - 1;
    while (value !== 0) {
      value &= value - 1;
      unmatched++;
    }
  }
  return length - unmatched;
}

function characterSimilarity(before: string, after: string, deadline: number): number | undefined {
  const timeout = deadline - performance.now();
  if (timeout <= 0) return undefined;
  const exact = codeUnitSimilarity(before, after);
  if (exact !== undefined) return exact;
  // Surrogate pairs and very long pairs: a minimal diff over code points, counted in code units.
  const parts = diffChars(before, after, { timeout, maxEditLength: 2_000 });
  if (parts === undefined) return undefined;
  const unchanged = parts
    .filter((part) => !part.added && !part.removed)
    .reduce((length, part) => length + part.value.length, 0);
  return unchanged / Math.max(before.length, after.length);
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
