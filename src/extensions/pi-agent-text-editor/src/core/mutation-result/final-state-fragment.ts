import type { FileTextWindow, ResultRange } from "pi-agent-resource";
import { requiredValue } from "pi-agent-invariant";
import { NO_FINAL_LINE_BREAK } from "pi-agent-text";

import {
  buildDiffLines,
  editRanges,
  expandAndMerge,
  isLineVisible,
  metadataForLine,
  selectSyntaxHints,
  splitLines,
} from "./agent-diff.ts";

import type { DiagnosticHint, FileMutationResult } from "./file-mutation-result.ts";

/** Inputs that decide which final lines a successful mutation shows. */
export interface FinalStateLineInput {
  readonly before: string;
  readonly after: string;
  readonly rawChanges: NonNullable<FileMutationResult["data"]["rawChanges"]>;
  readonly hints: readonly DiagnosticHint[];
}

/**
 * Lists every final line the fragment can show for these inputs, including all compiler errors,
 * so line presentation computed from it covers the rendered fragment.
 */
export function finalStateLineNumbers(input: FinalStateLineInput): number[] {
  const lineCount = Math.max(1, splitLines(input.after).length);
  const baseRanges = editRanges(
    { data: { rawChanges: input.rawChanges } },
    input.after,
    lineCount,
    input.rawChanges.length > 0 ? [] : buildDiffLines(input.before, input.after, lineCount),
  );
  const ranges = expandAndMerge(
    [
      ...baseRanges,
      ...input.hints
        .filter((hint) => hint.source === "compiler" && hint.severity === "error")
        .map((hint) => ({ start: hint.line, end: hint.line })),
    ],
    lineCount,
  );
  return ranges.flatMap((range) =>
    Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index),
  );
}

function finalStateFragment(fmr: FileMutationResult, path: string) {
  const before = fmr.data.snapshot?.content ?? fmr.data.beforeContentMap?.[path];
  const after = fmr.data.afterContent ?? fmr.data.afterDocument?.content;

  if (before == null || after === undefined) {
    return undefined;
  }

  const lines = splitLines(after);
  const lineCount = Math.max(1, lines.length);
  // Edit ranges come from the raw changes when they exist; only a mutation without them needs a diff.
  const diff =
    (fmr.data.rawChanges ?? []).length > 0 ? [] : buildDiffLines(before, after, lineCount);
  const baseRanges = editRanges(fmr, after, lineCount, diff);
  const visibleRanges = expandAndMerge(baseRanges, lineCount);
  const syntaxHints = fmr.hints.filter(
    (hint) => hint.source === "compiler" && hint.severity === "error",
  );
  const selectedSyntaxHints = selectSyntaxHints(syntaxHints, visibleRanges);
  const ranges = expandAndMerge(
    [
      ...baseRanges,
      ...selectedSyntaxHints
        .filter((hint) => !isLineVisible(hint.line, visibleRanges))
        .map((hint) => ({ start: hint.line, end: hint.line })),
    ],
    lineCount,
  );
  return { after, lines, ranges, visibleRanges, selectedSyntaxHints };
}

/** Renders the final file state around a successful mutation. */
export function renderFinalStateFragment(
  fmr: FileMutationResult,
  path: string,
  shown?: (window: FileTextWindow) => void,
): string[] {
  const fragment = finalStateFragment(fmr, path);
  if (fragment === undefined) return [path];
  const { after, lines, ranges, visibleRanges, selectedSyntaxHints } = fragment;
  const source = fmr.data.afterDocument?.source;
  if (shown !== undefined && source !== undefined && ranges.length > 0) {
    shown({
      source,
      content: after,
      ranges: ranges.map(({ start, end }): ResultRange => ({
        start: { lineNumber: start, column: 0 },
        end:
          end < lines.length || after.endsWith("\n")
            ? { lineNumber: end + 1, column: 0 }
            : { lineNumber: end, column: lines[end - 1]?.length ?? 0 },
      })),
    });
  }
  const allowedSyntaxHints = new Set<DiagnosticHint>(selectedSyntaxHints);
  const result = [path];

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    if (rangeIndex > 0) {
      result.push("...");
    }

    const range = requiredValue(ranges[rangeIndex]);

    result.push(`Final text, lines ${range.start}–${range.end}:`);
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      const content = lines[lineNumber - 1] ?? "";
      const metadata = metadataForLine(lineNumber, fmr.hints, visibleRanges, allowedSyntaxHints);
      const suffix = metadata.length === 0 ? "" : `  ${metadata.join(" ")}`;
      const prefix =
        fmr.data.resultPresentation === "major-anchor"
          ? (fmr.data.afterDocument?.lines[lineNumber - 1]?.presentation?.prefix ?? "")
          : "";
      result.push(`${prefix}${content}${suffix}`);
    }
    // The text shows the file as it is, including an end without a final LF.
    if (range.end >= lines.length && !after.endsWith("\n")) result.push(NO_FINAL_LINE_BREAK);
  }

  return result;
}
