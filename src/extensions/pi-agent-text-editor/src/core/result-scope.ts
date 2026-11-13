import path from "node:path";
import type { ResolvedResultTargets, ResultTargetStore } from "pi-agent-resource";
import type { TextAnchor, TextAnchorRecoveryRange, TextSelectionRange } from "pi-agent-text";
import { TextSelectionAnchor } from "#src/api/text-selection-anchor.ts";
import type { TextChangeDocument, TextRange } from "./text-change-engine.ts";

/**
 * A result passed with selectors only limits where they resolve; the selectors carry their own
 * checks. So its ranges may follow the file to their current region after other edits, which an
 * edit of the selected text itself refuses.
 */
export function resolveResultScope(
  store: ResultTargetStore,
  input: unknown,
  cwd: string,
): ResolvedResultTargets {
  const selected = store.resolve(input, cwd, { forEdit: true, allowAdjusted: true });
  return {
    complete: selected.complete,
    targets: selected.targets.map((target) => ({
      ...target,
      ranges: target.ranges.map(({ adjusted: _adjusted, ...range }) => range),
    })),
  };
}

/** The last line a range covers: a range that ends at the start of a line ends with the previous one. */
function lastLine({ start, end }: TextSelectionRange): number {
  return end.column === 0 && end.lineNumber > start.lineNumber
    ? end.lineNumber - 1
    : end.lineNumber;
}

/** Most lines of a result's selection shown with an anchor that missed it. */
const maxWindowLines = 40;

/**
 * Offsets of a selected range. A range that ends where a line ends also covers that line's break,
 * so a whole-line selection inside it, which includes the break, still counts as inside.
 */
function scopeOffsets(document: TextChangeDocument, range: TextSelectionRange): TextRange {
  const { from, to } = document.range(
    range.start.lineNumber,
    range.start.column,
    range.end.lineNumber,
    range.end.column,
  );
  const rest = document.content.slice(to, to + 2);
  return { from, to: to + (rest.startsWith("\r\n") ? 2 : /^[\r\n]/u.test(rest) ? 1 : 0) };
}

/** The ranges an anchor selects; a line anchor selects its whole line with its break. */
function anchorOffsets(document: TextChangeDocument, anchor: TextAnchor): TextRange[] {
  if (TextSelectionAnchor.is(anchor))
    return anchor.ranges.map((range) =>
      document.range(
        range.start.lineNumber,
        range.start.column,
        range.end.lineNumber,
        range.end.column,
      ),
    );
  return [document.lineRange(anchor.lineNumber, anchor.lineNumber)];
}

/**
 * The index of the scope range that holds everything the anchor selects, or `undefined` when the
 * anchor reaches outside the scope or spans two of its ranges.
 */
export function scopeRangeIndex(
  document: TextChangeDocument,
  anchor: TextAnchor,
  scope: readonly TextSelectionRange[],
): number | undefined {
  let selected: TextRange[];
  let ranges: TextRange[];
  try {
    selected = anchorOffsets(document, anchor);
    ranges = scope.map((range) => scopeOffsets(document, range));
  } catch {
    return undefined;
  }
  const index = ranges.findIndex((range) =>
    selected.every((part) => part.from >= range.from && part.to <= range.to),
  );
  return index < 0 ? undefined : index;
}

/** Names a file's selected ranges as an agent reads them, such as `task.txt lines 2-4`. */
export function describeScope(
  source: string,
  scope: readonly TextSelectionRange[],
  document: TextChangeDocument,
  cwd: string,
): string {
  // A file inside the workspace is named relative to it, as the agent usually names it.
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  const shown = source.startsWith(root) ? source.slice(root.length) : source;
  const lines = document.content.split(/\r\n|\r|\n/u);
  const parts = scope.map((range) => {
    const { start, end } = range;
    const last = lastLine(range);
    const wholeLines =
      start.column === 0 &&
      (end.column === 0
        ? end.lineNumber > start.lineNumber
        : end.column >= (lines[end.lineNumber - 1]?.length ?? 0));
    if (wholeLines)
      return last === start.lineNumber
        ? `line ${start.lineNumber}`
        : `lines ${start.lineNumber}-${last}`;
    // Columns are shown one-based, from the first selected character through the last.
    return start.lineNumber === end.lineNumber
      ? `line ${start.lineNumber} columns ${start.column + 1}-${end.column}`
      : `${start.lineNumber}:${start.column + 1} to ${end.lineNumber}:${end.column}`;
  });
  return `${shown} ${parts.join(", ")}`;
}

/** The lines of a selection, shown as recovery context when an anchor misses it. */
export function scopeWindow(scope: readonly TextSelectionRange[]): TextAnchorRecoveryRange {
  const first = Math.min(...scope.map((range) => range.start.lineNumber));
  const last = Math.max(...scope.map(lastLine));
  return { offset: first, limit: Math.min(maxWindowLines, last - first + 1) };
}
