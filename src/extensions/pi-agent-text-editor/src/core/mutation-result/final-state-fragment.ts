import { requiredValue } from "pi-agent-invariant";

import {
  buildDiffLines,
  editRanges,
  expandAndMerge,
  isLineVisible,
  metadataForLine,
  selectSyntaxHints,
  splitLines,
} from "./agent-diff.js";

import type { DiagnosticHint, FileMutationResult } from "./file-mutation-result.js";

/** Renders the final file state around a successful mutation. */
export function renderFinalStateFragment(fmr: FileMutationResult, path: string): string[] {
  const before = fmr.data.snapshot?.content ?? fmr.data.beforeContentMap?.[path];
  const after = fmr.data.afterContent ?? fmr.data.afterDocument?.content;

  if (before == null || after === undefined) {
    return [path];
  }

  const lines = splitLines(after);
  const lineCount = Math.max(1, lines.length);
  const diff = buildDiffLines(before, after, lineCount);
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
  const allowedSyntaxHints = new Set<DiagnosticHint>(selectedSyntaxHints);
  const result = [path];

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    if (rangeIndex > 0) {
      result.push("...");
    }

    const range = requiredValue(ranges[rangeIndex]);
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
  }

  return result;
}
