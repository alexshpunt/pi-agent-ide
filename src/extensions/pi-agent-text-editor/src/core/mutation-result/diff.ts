import { requiredValue } from "pi-agent-invariant";
import { type Change, diffLines, formatPatch, type StructuredPatchHunk } from "diff";

export interface DiffStats {
  removed: number;
  added: number;
}

export interface UnifiedDiffResult {
  diff: string;
  stats: DiffStats;
}

const PATCH_CONTEXT_LINES = 3;

/**
 * Creates a unified diff with three context lines, as jsdiff's `createTwoFilesPatch` does, but runs
 * the line diff only over the lines that differ.
 */
export function createUnifiedDiff(
  path: string,
  beforeContent: string,
  afterContent: string,
  afterPath = path,
): UnifiedDiffResult {
  const window = lineDiffWindow(beforeContent, afterContent, PATCH_CONTEXT_LINES);
  const stats: DiffStats = { removed: 0, added: 0 };
  for (const part of window.parts) {
    if (part.added) {
      stats.added += part.count;
    } else if (part.removed) {
      stats.removed += part.count;
    }
  }
  const diff = formatPatch({
    oldFileName: path,
    newFileName: afterPath,
    oldHeader: "",
    newHeader: "",
    hunks: patchHunks(window.parts, window.skippedLines + 1, PATCH_CONTEXT_LINES),
  })
    .replace(/^(?:Index: .*\n)?={3,}\n?/m, "")
    .trimEnd();

  return { diff, stats };
}

/**
 * Diffs two texts line by line like jsdiff's `diffLines`, but only runs the diff over the lines
 * between their common leading and trailing lines, so a small edit of a large file stays cheap.
 */
export function diffTextLines(beforeContent: string, afterContent: string): Change[] {
  return lineDiffWindow(beforeContent, afterContent, Infinity).parts;
}

interface LineDiffWindow {
  /** Number of unchanged lines before the first part. */
  readonly skippedLines: number;
  /** Line diff parts; unchanged parts keep at most the requested context around changes. */
  readonly parts: Change[];
}

/**
 * Trims the common leading and trailing lines, diffs the rest with jsdiff and surrounds the result
 * with up to `contextLines` of the trimmed lines on each side. Lines end after `\n`, as in jsdiff's
 * line tokens, so the parts match what `diffLines` returns for that region.
 */
function lineDiffWindow(before: string, after: string, contextLines: number): LineDiffWindow {
  const shorter = Math.min(before.length, after.length);
  let common = 0;
  while (common < shorter && before.charCodeAt(common) === after.charCodeAt(common)) {
    common += 1;
  }
  const prefixEnd =
    common === before.length && common === after.length
      ? common
      : common === 0
        ? 0
        : before.lastIndexOf("\n", common - 1) + 1;

  let commonSuffix = 0;
  const maxSuffix = shorter - prefixEnd;
  while (
    commonSuffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - commonSuffix) ===
      after.charCodeAt(after.length - 1 - commonSuffix)
  ) {
    commonSuffix += 1;
  }
  // The trailing lines start after a line break that lies inside the common suffix.
  const breakInSuffix = before.indexOf("\n", before.length - commonSuffix);
  const suffixStart =
    commonSuffix === 0 || breakInSuffix === -1 ? before.length : breakInSuffix + 1;
  const afterSuffixStart = after.length - (before.length - suffixStart);

  let contextStart = prefixEnd;
  let contextEnd = suffixStart;
  if (contextLines === Infinity) {
    contextStart = 0;
    contextEnd = before.length;
  } else {
    for (let line = 0; line < contextLines && contextStart > 0; line += 1) {
      contextStart = contextStart < 2 ? 0 : before.lastIndexOf("\n", contextStart - 2) + 1;
    }
    for (let line = 0; line < contextLines && contextEnd < before.length; line += 1) {
      const lineBreak = before.indexOf("\n", contextEnd);
      contextEnd = lineBreak === -1 ? before.length : lineBreak + 1;
    }
  }

  const parts: Change[] = [];
  const pushUnchanged = (value: string) => {
    if (value.length === 0) {
      return;
    }
    const last = parts.at(-1);
    if (last !== undefined && !last.added && !last.removed) {
      last.value += value;
      last.count += countDiffLines(value);
    } else {
      parts.push({ value, count: countDiffLines(value), added: false, removed: false });
    }
  };

  pushUnchanged(before.slice(contextStart, prefixEnd));
  if (prefixEnd < suffixStart || prefixEnd < afterSuffixStart) {
    for (const part of diffLines(
      before.slice(prefixEnd, suffixStart),
      after.slice(prefixEnd, afterSuffixStart),
    )) {
      if (part.added || part.removed) {
        parts.push(part);
      } else {
        pushUnchanged(part.value);
      }
    }
  }
  pushUnchanged(before.slice(suffixStart, contextEnd));
  return { skippedLines: countLineBreaks(before, contextStart), parts };
}

/** Groups line diff parts into unified diff hunks the way jsdiff's `structuredPatch` does. */
function patchHunks(
  parts: readonly Change[],
  firstLine: number,
  context: number,
): StructuredPatchHunk[] {
  const hunks: StructuredPatchHunk[] = [];
  const partLines = parts.map((part) => patchLines(part.value));
  let oldRangeStart = 0;
  let newRangeStart = 0;
  let range: string[] = [];
  let oldLine = firstLine;
  let newLine = firstLine;

  for (let index = 0; index < parts.length; index += 1) {
    const part = requiredValue(parts[index]);
    const lines = requiredValue(partLines[index]);
    if (part.added || part.removed) {
      if (oldRangeStart === 0) {
        const previous = partLines[index - 1];
        oldRangeStart = oldLine;
        newRangeStart = newLine;
        range =
          previous === undefined || context === 0
            ? []
            : previous.slice(-context).map((line) => ` ${line}`);
        oldRangeStart -= range.length;
        newRangeStart -= range.length;
      }
      for (const line of lines) {
        range.push(`${part.added ? "+" : "-"}${line}`);
      }
      if (part.added) {
        newLine += lines.length;
      } else {
        oldLine += lines.length;
      }
      continue;
    }

    if (oldRangeStart !== 0) {
      if (lines.length <= context * 2 && index < parts.length - 1) {
        range.push(...lines.map((line) => ` ${line}`));
      } else {
        const contextSize = Math.min(lines.length, context);
        range.push(...lines.slice(0, contextSize).map((line) => ` ${line}`));
        hunks.push({
          oldStart: oldRangeStart,
          oldLines: oldLine - oldRangeStart + contextSize,
          newStart: newRangeStart,
          newLines: newLine - newRangeStart + contextSize,
          lines: range,
        });
        oldRangeStart = 0;
        newRangeStart = 0;
        range = [];
      }
    }
    oldLine += lines.length;
    newLine += lines.length;
  }

  if (oldRangeStart !== 0) {
    hunks.push({
      oldStart: oldRangeStart,
      oldLines: oldLine - oldRangeStart,
      newStart: newRangeStart,
      newLines: newLine - newRangeStart,
      lines: range,
    });
  }

  for (const hunk of hunks) {
    hunk.lines = hunk.lines.flatMap((line) =>
      line.endsWith("\n") ? [line.slice(0, -1)] : [line, "\\ No newline at end of file"],
    );
  }
  return hunks;
}

/** Splits a part into lines that keep their trailing `\n`. */
function patchLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n").map((line) => `${line}\n`);
  const last = requiredValue(lines.pop());
  if (!text.endsWith("\n")) {
    lines.push(last.slice(0, -1));
  }
  return lines;
}

function countLineBreaks(value: string, end: number): number {
  let count = 0;
  for (let index = value.indexOf("\n"); index !== -1 && index < end;) {
    count += 1;
    index = value.indexOf("\n", index + 1);
  }
  return count;
}

function countDiffLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const lineBreaks = countLineBreaks(value, value.length);
  return value.endsWith("\n") ? lineBreaks : lineBreaks + 1;
}

export interface ChangedRange {
  /**
    1-based, inclusive — line number in the AFTER file
    */
  start: number;
  /**
    1-based, inclusive — line number in the AFTER file
    */
  end: number;
}

/**
 * Compute the line ranges that changed in the AFTER file compared to the
 * BEFORE file. Returns 1-based inclusive ranges in the AFTER file's line
 * numbering. Adjacent ranges are merged into single islands.
 */
export function computeChangedRanges(beforeContent: string, afterContent: string): ChangedRange[] {
  const parts = diffTextLines(beforeContent, afterContent);
  const ranges: ChangedRange[] = [];
  let afterLine = 0;

  for (const part of parts) {
    const lineCount = countDiffLines(part.value);

    if (lineCount === 0) {
      continue;
    }

    if (part.removed) {
      // removed lines do not advance the AFTER cursor
      continue;
    }

    if (part.added) {
      ranges.push({ start: afterLine + 1, end: afterLine + lineCount });
    }

    afterLine += lineCount;
  }

  return mergeAdjacentRanges(ranges);
}

function mergeAdjacentRanges(ranges: ChangedRange[]): ChangedRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ChangedRange[] = [requiredValue(sorted[0])];

  for (let index = 1; index < sorted.length; index++) {
    const last = requiredValue(merged.at(-1));
    const current = requiredValue(sorted[index]);

    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}
