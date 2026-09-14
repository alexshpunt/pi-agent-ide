import { requiredValue } from "pi-agent-invariant";
import { diffLines } from "diff";
import { type PresentedTextRow, renderPresentedTextRows } from "pi-agent-text";

import { formatHint } from "./inline-hints.js";

import type { DiagnosticHint, FileMutationResult } from "./file-mutation-result.js";

const CONTEXT_LINES = 5;
const MAX_SYNTAX_ERRORS = 5;

const SEVERITY_RANK: Record<DiagnosticHint["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

export interface AgentDiffLine {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
  readonly beforeLine?: number;
  readonly afterLine?: number;
  readonly positionLine: number;
}

export interface LineRange {
  start: number;
  end: number;
}

export function renderAgentDiff(fmr: FileMutationResult, diffPath: string): string[] {
  const presentedAfter = fmr.data.afterDocument;
  const before = fmr.data.snapshot?.content ?? fmr.data.beforeContentMap?.[diffPath] ?? undefined;
  const after = fmr.data.afterContent ?? presentedAfter?.content;

  if (before === undefined || after === undefined) {
    return renderUnavailableSourceDiff(fmr, diffPath);
  }

  const afterLines = splitLines(after);
  const displayLineCount = Math.max(1, afterLines.length);
  const diffLines = buildDiffLines(before, after, displayLineCount);
  const baseRanges = editRanges(fmr, after, displayLineCount, diffLines);
  const visibleRanges = expandAndMerge(baseRanges, displayLineCount);
  const syntaxHints = fmr.hints.filter(
    (hint) => hint.source === "compiler" && hint.severity === "error",
  );
  const selectedSyntaxHints = selectSyntaxHints(syntaxHints, visibleRanges);
  const allRanges = expandAndMerge(
    [
      ...baseRanges,
      ...selectedSyntaxHints
        .filter((hint) => !isLineVisible(hint.line, visibleRanges))
        .map((hint) => ({ start: hint.line, end: hint.line })),
    ],
    displayLineCount,
  );
  const added = diffLines.filter((line) => line.kind === "added").length;
  const removed = diffLines.filter((line) => line.kind === "removed").length;
  const entries: (string | PresentedTextRow)[] = [`${diffPath} +${added} -${removed}`];
  const allowedSyntaxHints = new Set(selectedSyntaxHints);
  const scopeMarkers = fmr.data.scopeMarkers ?? {};

  for (let rangeIndex = 0; rangeIndex < allRanges.length; rangeIndex += 1) {
    if (rangeIndex > 0) {
      entries.push("...");
    }

    const range = requiredValue(allRanges[rangeIndex]);

    for (const line of diffLines) {
      if (!isDiffLineVisible(line, range)) {
        continue;
      }

      if (line.kind === "removed") {
        entries.push({ marker: "-", prefix: "|", content: line.text });
        continue;
      }

      if (presentedAfter !== undefined) {
        const presentedLine = presentedAfter.lines[requiredValue(line.afterLine) - 1];
        const prefix = presentedLine?.presentation?.prefix ?? "";
        const suffix = presentedLine?.presentation?.suffix ?? "";
        const metadata = metadataForLine(
          requiredValue(line.afterLine),
          fmr.hints,
          visibleRanges,
          allowedSyntaxHints,
        );
        const metadataSuffix = metadata.length > 0 ? `  ${metadata.join(" ")}` : "";
        entries.push({
          marker: line.kind === "added" ? "+" : " ",
          prefix,
          content: line.text,
          suffix: `${suffix}${metadataSuffix}`,
        });
        continue;
      }

      const lineNumber = requiredValue(line.afterLine);
      const metadata = metadataForLine(
        lineNumber,
        fmr.hints,
        visibleRanges,
        allowedSyntaxHints,
        scopeMarkers[String(lineNumber)] ?? scopeMarkers[lineNumber],
      );
      const suffix = metadata.length > 0 ? `  ${metadata.join(" ")}` : "";
      entries.push({
        marker: line.kind === "added" ? "+" : " ",
        prefix: "|",
        content: line.text,
        suffix,
      });
    }
  }

  return renderDiffEntries(entries);
}

function renderDiffEntries(entries: readonly (string | PresentedTextRow)[]): string[] {
  const renderedRows = renderPresentedTextRows(entries.filter(isPresentedTextRow));
  let rowIndex = 0;

  return entries.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }

    return requiredValue(renderedRows[rowIndex++]);
  });
}

function isPresentedTextRow(entry: string | PresentedTextRow): entry is PresentedTextRow {
  return typeof entry !== "string";
}

function renderUnavailableSourceDiff(fmr: FileMutationResult, diffPath: string): string[] {
  const diff = fmr.diffs.find((value) => extractDiffPath(value) === diffPath) ?? fmr.diffs[0] ?? "";
  const body = diff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ") &&
        !line.startsWith("@@ ") &&
        !line.startsWith("\\ No newline"),
    );
  const added = body.filter((line) => line.startsWith("+")).length;
  const removed = body.filter((line) => line.startsWith("-")).length;
  const entries: (string | PresentedTextRow)[] = [`${diffPath} +${added} -${removed}`];

  for (const line of body) {
    const marker = line[0];

    if (marker !== "+" && marker !== "-" && marker !== " ") {
      entries.push(line);
      continue;
    }

    entries.push({ marker, prefix: "|", content: line.slice(1) });
  }

  return renderDiffEntries(entries);
}

export function buildDiffLines(
  before: string,
  after: string,
  afterLineCount: number,
): AgentDiffLine[] {
  const result: AgentDiffLine[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const part of diffLines(before, after)) {
    for (const text of splitPartLines(part.value)) {
      if (part.added) {
        result.push({ kind: "added", text, afterLine, positionLine: afterLine });
        afterLine += 1;
      } else if (part.removed) {
        const positionLine = Math.max(1, Math.min(afterLine, afterLineCount));
        result.push({ kind: "removed", text, beforeLine, positionLine });
        beforeLine += 1;
      } else {
        result.push({ kind: "context", text, beforeLine, afterLine, positionLine: afterLine });
        beforeLine += 1;
        afterLine += 1;
      }
    }
  }

  return result;
}

export function editRanges(
  fmr: FileMutationResult,
  after: string,
  afterLineCount: number,
  diff: readonly AgentDiffLine[],
): LineRange[] {
  const rawChanges = fmr.data.rawChanges ?? [];

  if (rawChanges.length > 0) {
    return rawChanges.map((change) => ({
      start: lineAtOffset(after, change.fromB),
      end: lineAtOffset(
        after,
        Math.max(change.fromB, change.toB - (change.toB > change.fromB ? 1 : 0)),
      ),
    }));
  }

  const changedLines = diff
    .filter((line) => line.kind !== "context")
    .map((line) => line.positionLine);

  if (changedLines.length === 0) {
    return [];
  }

  return [
    {
      start: Math.max(1, Math.min(...changedLines)),
      end: Math.min(afterLineCount, Math.max(...changedLines)),
    },
  ];
}

export function expandAndMerge(ranges: readonly LineRange[], lineCount: number): LineRange[] {
  if (lineCount === 0) {
    return [];
  }

  const windows = ranges
    .map((range) => ({
      start: Math.max(1, Math.min(lineCount, range.start) - CONTEXT_LINES),
      end: Math.min(lineCount, Math.max(range.start, range.end) + CONTEXT_LINES),
    }))
    .sort((left, right) => left.start - right.start);

  if (windows.length === 0) {
    return [];
  }

  const merged: LineRange[] = [requiredValue(windows[0])];

  for (const current of windows.slice(1)) {
    const previous = requiredValue(merged.at(-1));

    if (current.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

export function selectSyntaxHints(
  hints: readonly DiagnosticHint[],
  visibleRanges: readonly LineRange[],
): DiagnosticHint[] {
  const visible = hints
    .filter((hint) => isLineVisible(hint.line, visibleRanges))
    .sort((left, right) => left.line - right.line);
  const hidden = hints
    .filter((hint) => !isLineVisible(hint.line, visibleRanges))
    .sort(compareHints);

  return [...visible, ...hidden.slice(0, Math.max(0, MAX_SYNTAX_ERRORS - visible.length))];
}

function compareHints(left: DiagnosticHint, right: DiagnosticHint): number {
  return (
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}

export function metadataForLine(
  lineNumber: number,
  hints: readonly DiagnosticHint[],
  visibleRanges: readonly LineRange[],
  allowedSyntaxHints: ReadonlySet<DiagnosticHint>,
  scopeMarkers?: readonly string[],
): string[] {
  const metadata: string[] = [];

  if (scopeMarkers !== undefined && scopeMarkers.length > 0) {
    metadata.push(`<!-- ${scopeMarkers.join(" ")} -->`);
  }

  const isLineIsVisible = isLineVisible(lineNumber, visibleRanges);
  const lineHints = hints.filter(
    (hint) => hint.line === lineNumber && (isLineIsVisible || allowedSyntaxHints.has(hint)),
  );

  if (lineHints.length > 0) {
    metadata.push(
      `<!-- lsp: ${lineHints.map((hint) => formatHint(hint, { includeAnchor: false })).join(" | ")} -->`,
    );
  }

  return metadata;
}

function isDiffLineVisible(line: AgentDiffLine, range: LineRange): boolean {
  return line.positionLine >= range.start && line.positionLine <= range.end;
}

export function isLineVisible(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function lineAtOffset(content: string, offset: number): number {
  const boundedOffset = Math.max(0, Math.min(content.length, offset));
  return content.slice(0, boundedOffset).split("\n").length;
}

export function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function splitPartLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function extractDiffPath(diff: string): string | undefined {
  return /^--- (.+)$/m.exec(diff)?.[1];
}
