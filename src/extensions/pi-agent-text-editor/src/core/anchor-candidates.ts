import { requiredValue } from "pi-agent-invariant";
import {
  createTextDocument,
  documentLineAnchors,
  linesWithAnchor,
  type TextAnchorRecoveryCandidateRange,
  type TextAnchorRecoveryRange,
} from "pi-agent-text";

import { previewAnchoredLine } from "./anchor-preview.ts";
import { TextChangeDocument } from "./text-change-engine.ts";

const SHOWN_CANDIDATES = 5;
const MAX_MATCH_LINES = 12;

/** Fields that use the last line of a match instead of its first. */
const END_FIELDS = new Set(["through", "after", "targetThrough", "targetAfter"]);

export interface AnchorCandidates {
  readonly field: string;
  readonly source: string;
  readonly content: string;
  readonly candidates: readonly TextAnchorRecoveryCandidateRange[];
  readonly total: number;
  /** A paired end's line anchor must not start before this UTF-16 offset. */
  readonly minimumOffset?: number;
  readonly scope?: readonly TextAnchorRecoveryCandidateRange[];
}

/** Render candidates from the rejected snapshot, not from later reads of the file. */
export function presentAnchorCandidates(
  options: AnchorCandidates,
  contextLines: number,
):
  | {
      readonly text: string;
      readonly windows: readonly TextAnchorRecoveryRange[];
    }
  | undefined {
  const { field, source, content, candidates, total, minimumOffset, scope } = options;
  if (candidates.length === 0) return undefined;
  const { lines } = createTextDocument(source, content);
  const anchors = documentLineAnchors(lines);
  const end = END_FIELDS.has(field);
  const offsets = minimumOffset === undefined ? undefined : new TextChangeDocument(content);
  const padding = Math.min(contextLines, 1);
  const windows: TextAnchorRecoveryRange[] = [];
  const blocks: string[] = [];
  let example: string | undefined;
  for (const range of candidates) {
    if (blocks.length === SHOWN_CANDIDATES) break;
    const first = range.start.lineNumber;
    const last = Math.max(
      first,
      range.end.column === 0 ? range.end.lineNumber - 1 : range.end.lineNumber,
    );
    const line = end ? last : first;
    const chosen = lines[line - 1];
    const anchor = anchors[line - 1];
    if (
      anchor === undefined ||
      chosen === undefined ||
      (minimumOffset !== undefined &&
        Math.min(
          requiredValue(offsets).lineContentStart(first) + range.start.column,
          requiredValue(offsets).lineContentStart(line),
        ) < minimumOffset) ||
      (scope !== undefined && !scope.some((range) => startsOnScopedLine(line, range)))
    )
      continue;
    const offset = Math.max(1, first - padding);
    const to = Math.min(lines.length, last + padding);
    const rows = (from: number, to: number) =>
      lines
        .slice(from - 1, to)
        .map(({ content }, index) =>
          previewAnchoredLine(requiredValue(anchors[from + index - 1]), content),
        );
    const truncated = last - first + 1 > MAX_MATCH_LINES;
    const parts = truncated
      ? [
          { from: offset, to: first + MAX_MATCH_LINES / 2 - 1 },
          { from: last - MAX_MATCH_LINES / 2 + 1, to },
        ]
      : [{ from: offset, to }];
    for (const part of parts) windows.push({ offset: part.from, limit: part.to - part.from + 1 });
    blocks.push(
      `Candidate ${anchor}:\n${parts.map(({ from, to }) => rows(from, to).join("\n")).join("\n…\n")}`,
    );
    if (example === undefined && linesWithAnchor(anchors, anchor).length === 1) {
      const note =
        last > first && (field === "at" || field === "targetAt")
          ? ". This selects one line. Use a range to select the full multiline match."
          : "";
      example = `${field}: "${anchor}"${note}`;
    }
  }
  if (blocks.length === 0) return undefined;
  const more = total > blocks.length ? `\n… ${total - blocks.length} more matches.` : "";
  const retry =
    example === undefined
      ? `Use Search or unique exact text to select the intended match for ${field}.`
      : `Example: ${example}`;
  return { text: `Candidates:\n${blocks.join("\n\n")}${more}\n\n${retry}`, windows };
}

function startsOnScopedLine(
  line: number,
  { start, end }: TextAnchorRecoveryCandidateRange,
): boolean {
  return (
    start.lineNumber <= line &&
    (line < end.lineNumber ||
      (line === end.lineNumber && (end.column > 0 || start.lineNumber === line)))
  );
}
