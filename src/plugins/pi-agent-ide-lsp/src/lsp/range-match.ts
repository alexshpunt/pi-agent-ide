import { requiredValue } from "pi-agent-invariant";
import type { SearchSelectionMatch } from "pi-agent-search/api/search";
import type { TextDocument } from "pi-agent-text";

import { sourceChanged } from "./source-changes.ts";
import type { LspRange } from "./types.ts";

/**
 * The exact text of an LSP range as a search match. A position outside the text means the file
 * changed after the server answered, so the search runs again.
 */
export function lspRangeMatch(
  source: string,
  document: TextDocument,
  range: LspRange,
): SearchSelectionMatch {
  const { start, end } = range;
  for (const position of [start, end]) {
    const line = document.lines[position.line];
    if (
      !Number.isInteger(position.line) ||
      !Number.isInteger(position.character) ||
      line === undefined ||
      position.character < 0 ||
      position.character > line.content.length
    )
      throw sourceChanged("LSP range does not match its source snapshot.");
  }
  const offset = (line: number) =>
    document.lines
      .slice(0, line)
      .reduce((total, row) => total + row.content.length + row.lineEnding.length, 0);
  const from = offset(start.line) + start.character;
  const to = offset(end.line) + end.character;
  if (to < from) throw new Error("LSP returned a reversed source range.");
  return {
    source,
    lineNumber: start.line + 1,
    endLineNumber: end.line + 1,
    startColumn: start.character,
    endColumn: end.character,
    matchedText: document.content.slice(from, to),
    lineText: requiredValue(document.lines[start.line]).content,
  };
}
