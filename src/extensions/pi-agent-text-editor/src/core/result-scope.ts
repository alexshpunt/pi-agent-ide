import path from "node:path";
import type { ResolvedResultTargets, ResultTargetStore } from "pi-agent-resource";
import {
  createTextDocument,
  documentLineAnchors,
  type TextAnchor,
  type TextAnchorRecoveryRange,
  type TextSelectionRange,
} from "pi-agent-text";
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
  // The scope is not the edit selection; guarded selectors are resolved separately.
  const selected = store.resolve(input, cwd, { allowAdjusted: true, forScope: true });
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
  return { from, to: to + lineBreakAt(document.content, to) };
}

/**
 * The length of the LF at `offset`, or of a CRLF when a range stops before a CRLF line's CR. Only
 * LF ends a line; a lone CR is ordinary text.
 */
function lineBreakAt(content: string, offset: number): number {
  return content.startsWith("\r\n", offset) ? 2 : content[offset] === "\n" ? 1 : 0;
}

/**
 * The scope range holding each independent anchor selection. Line selectors use the containing
 * lines of the scope; exact selectors keep its column boundaries. No selection may cross a gap.
 */
export function scopeRangeIndices(
  document: TextChangeDocument,
  anchor: TextAnchor,
  scope: readonly TextSelectionRange[],
): readonly number[] | undefined {
  try {
    const ranges = scope.map((range) => scopeOffsets(document, range));
    const lines = scope.map((range) => document.lineRange(range.start.lineNumber, lastLine(range)));
    const selected = TextSelectionAnchor.is(anchor)
      ? anchor.ranges.map((range) => ({
          offsets: document.range(
            range.start.lineNumber,
            range.start.column,
            range.end.lineNumber,
            range.end.column,
          ),
          linewise: range.linewise === true,
        }))
      : [{ offsets: document.lineRange(anchor.lineNumber, anchor.lineNumber), linewise: true }];
    const indices = selected.map(({ offsets: part, linewise }) =>
      (linewise ? lines : ranges).findIndex(
        (range) => part.from >= range.from && part.to <= range.to,
      ),
    );
    return indices.some((index) => index < 0) ? undefined : indices;
  } catch {
    return undefined;
  }
}

/** Names a result's scope by the anchors bounding each selected range, not by line numbers. */
export function describeScope(
  source: string,
  scope: readonly TextSelectionRange[],
  document: TextChangeDocument,
  cwd: string,
): string {
  // A file inside the workspace is named relative to it, as the agent usually names it.
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  const shown = source.startsWith(root) ? source.slice(root.length) : source;
  if (scope.length === 0) return shown;
  const { lines } = createTextDocument(source, document.content);
  const anchors = documentLineAnchors(lines);
  const limit = 5;
  const parts = scope.slice(0, limit).flatMap((range) => {
    const first = anchors[range.start.lineNumber - 1];
    const last = anchors[lastLine(range) - 1];
    if (first === undefined || last === undefined) return [];
    return [first === last ? first : `${first} through ${last}`];
  });
  const omitted = scope.length > limit ? `, … ${scope.length - limit} more ranges` : "";
  return parts.length === 0 ? shown : `${shown} (${parts.join(", ")}${omitted})`;
}

/** The lines of a selection, shown as recovery context when an anchor misses it. */
export function scopeWindow(scope: readonly TextSelectionRange[]): TextAnchorRecoveryRange {
  const first = Math.min(...scope.map((range) => range.start.lineNumber));
  const last = Math.max(...scope.map(lastLine));
  return { offset: first, limit: Math.min(maxWindowLines, last - first + 1) };
}
