import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResultPanel, sourceRows, type ResultPanelRow } from "pi-agent-tool-ui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SearchSelectionMatch } from "./search.js";

/** Present Search ranges consistently, without adding targets or pretending readonly sources are files. */
export function renderSearchMatches(
  matches: readonly SearchSelectionMatch[],
  complete: boolean,
  theme: Theme,
  expanded: boolean,
  cwd?: string,
  notices: readonly string[] = [],
  metadata: readonly string[] = [],
): ResultPanel {
  const rows: ResultPanelRow[] = notices.map((text) => ({ kind: "note", text }));
  rows.push(
    ...sourceRows(
      matches.flatMap((match) => {
        const local = path.isAbsolute(match.source);
        const label =
          local && cwd
            ? path.relative(cwd, match.source) || path.basename(match.source)
            : match.source;
        const link = local
          ? pathToFileURL(match.source).href
          : /^https?:/iu.test(match.source)
            ? match.source
            : undefined;
        const endLine = match.endLineNumber ?? match.lineNumber;
        const lines =
          endLine === match.lineNumber
            ? [match.lineText]
            : [match.lineText, ...match.matchedText.split(/\r\n|\n|\r/u).slice(1)];
        return lines
          .slice(0, 20)
          .map((text, index) => ({
            source: match.source,
            label,
            ...(link === undefined ? {} : { link }),
            ...(!local ? { badge: /^https?:/iu.test(match.source) ? "WEB" : "SH" } : {}),
            lineNumber: match.lineNumber + index,
            text,
            ranges: [
              {
                from: index ? 0 : match.startColumn,
                to: match.lineNumber + index === endLine ? match.endColumn : text.length,
              },
            ],
          }));
      }),
    ),
  );
  if (!matches.length) rows.push({ kind: "note", text: "No matches found" });
  if (matches.some((m) => (m.endLineNumber ?? m.lineNumber) - m.lineNumber >= 20))
    rows.push({ kind: "note", text: "… source preview shortened" });
  rows.push(...metadata.map((text) => ({ kind: "note" as const, text, expandedOnly: true })));
  const count = `${matches.length}${complete ? "" : "+"}`;
  const sources = new Set(matches.map((m) => m.source));
  const local = matches.every((m) => path.isAbsolute(m.source));
  return new ResultPanel(
    {
      summary: `${count} ${matches.length === 1 ? "match" : "matches"} in ${sources.size} ${local ? (sources.size === 1 ? "file" : "files") : sources.size === 1 ? "source" : "sources"}`,
      rows,
    },
    theme,
    expanded,
  );
}
