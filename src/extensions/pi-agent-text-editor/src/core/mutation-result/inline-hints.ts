import { requiredValue } from "pi-agent-invariant";
import type { DiagnosticHint } from "./file-mutation-result.js";

export interface InsertHintsOptions {
  readonly suppressContextHunksFor?: (hint: DiagnosticHint) => boolean;
}

export function insertHintsIntoDiff(
  diff: string,
  hints: readonly DiagnosticHint[],
  options: InsertHintsOptions = {},
): string {
  if (hints.length === 0) {
    return diff;
  }

  const result: string[] = [];
  const shown = new Set<number>();
  let afterLine = 0;

  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk) {
      afterLine = Number(hunk[1]) - 1;
      result.push(line);
      continue;
    }

    const isAfterLine = (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ");

    if (!isAfterLine) {
      result.push(line);
      continue;
    }

    afterLine++;
    const lineHints = hints.filter((hint) => hint.line === afterLine);
    result.push(
      lineHints.length === 0
        ? line
        : `${line}  <!-- lsp: ${lineHints.map((hint) => formatHint(hint)).join(" | ")} -->`,
    );

    for (const hint of lineHints) {
      shown.add(hint.line);
    }
  }

  return insertContextHunks(result, hints, shown, options).join("\n");
}

function insertContextHunks(
  result: string[],
  hints: readonly DiagnosticHint[],
  shown: ReadonlySet<number>,
  options: InsertHintsOptions,
): string[] {
  const contextual = hints
    .filter((hint) => !shown.has(hint.line) && hint.lineText !== undefined)
    .filter((hint) => !options.suppressContextHunksFor?.(hint))
    .map((hint) => ({
      line: hint.line,
      lines: [
        `@@ -${hint.line},1 +${hint.line},1 @@`,
        ` ${hint.lineText}  <!-- lsp: ${formatHint(hint)} -->`,
      ],
    }));

  if (contextual.length === 0) {
    return result;
  }

  const prefix: string[] = [];
  const hunks: { line: number; lines: string[] }[] = [];

  for (const line of result) {
    const hunk = /^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk) {
      hunks.push({ line: Number(hunk[1]), lines: [line] });
    } else if (hunks.length === 0) {
      prefix.push(line);
    } else {
      requiredValue(hunks.at(-1)).lines.push(line);
    }
  }

  const ordered = [...hunks, ...contextual].sort((left, right) => left.line - right.line);
  return [...prefix, ...ordered.flatMap((hunk) => hunk.lines)];
}

export function renderDiffForAgent(diff: string): string[] {
  return diff.split("\n").slice(2);
}

export function formatHint(
  hint: DiagnosticHint,
  options: { includeAnchor?: boolean } = {},
): string {
  const source = hint.source ? `${hint.source}:` : "";
  const anchor =
    options.includeAnchor === false || hint.anchor === undefined ? "" : `${hint.anchor} — `;
  return `[${hint.severity.toUpperCase()}] ${anchor}${source}${hint.code}: ${hint.message}`;
}
