import {
  type AgentToolResult,
  keyText,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { ResultPanel, type ResultPanelRow } from "pi-agent-tool-ui";
import { isSearchToolDetails } from "#src/search-result.js";
import { restoreSearchDetails } from "#src/persisted-result.js";
const restoredDetails = new WeakMap<object, SearchToolDetails>();

import type { SearchResultFile, SearchResultLine, SearchToolDetails } from "#src/search-result.js";

const COMPACT_SEARCH_ROWS = 12;

interface SearchRenderContext {
  readonly lastComponent: Component | undefined;
  readonly isError?: boolean;
}

type SearchPanelRow =
  | { readonly kind: "file"; readonly file: SearchResultFile }
  | { readonly kind: "line"; readonly file: SearchResultFile; readonly line: SearchResultLine }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "omitted"; readonly matches: number }
  | { readonly kind: "empty" };

export function renderSearchResult(
  result: AgentToolResult<SearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: SearchRenderContext,
): Component {
  if (typeof result.details === "object") {
    let details = restoredDetails.get(result.details);
    if (details === undefined) {
      details = restoreSearchDetails(
        result.details,
        result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
      );
      restoredDetails.set(result.details, details);
    }
    result = { ...result, details };
  }
  if (options.isPartial || context.isError || !isSearchToolDetails(result.details)) {
    const content = result.content[0];
    const text = content?.type === "text" ? content.text : "";
    const color: ThemeColor = context.isError ? "error" : options.isPartial ? "dim" : "toolOutput";
    return new Text(theme.fg(color, text), 0, 0);
  }

  const previous =
    context.lastComponent instanceof SearchResultPanel ? context.lastComponent : undefined;
  const panel = previous ?? new SearchResultPanel(result.details, theme, options.expanded);
  panel.updateSearch(result.details, theme, options.expanded);
  return panel;
}

/** Adapt Search counts and compacted groups to the shared result frame. */
export class SearchResultPanel extends ResultPanel {
  public constructor(details: SearchToolDetails, theme: Theme, expanded: boolean) {
    super(searchModel(details, expanded), theme, expanded);
  }
  public updateSearch(details: SearchToolDetails, theme: Theme, expanded: boolean): void {
    super.update(searchModel(details, expanded), theme, expanded);
  }
}
function searchModel(details: SearchToolDetails, expanded: boolean) {
  const rows = searchViewport(details, expanded).map((row): ResultPanelRow => {
    if (row.kind === "file")
      return {
        kind: "source",
        label: row.file.path,
        link: row.file.link,
        count: row.file.matchCount,
      };
    if (row.kind === "line") return { kind: "line", ...row.line };
    if (row.kind === "summary") return { kind: "note", text: row.text };
    if (row.kind === "omitted")
      return {
        kind: "note",
        text: `… ${row.matches} more ${plural(row.matches, "match", "matches")} · ${keyText("app.tools.expand")} to expand`,
      };
    return { kind: "note", text: "No matches found" };
  });
  return { summary: searchSummary(details), rows };
}
function searchViewport(details: SearchToolDetails, expanded: boolean): readonly SearchPanelRow[] {
  const rows =
    details.files.length === 0
      ? [{ kind: "empty" } satisfies SearchPanelRow]
      : details.files.flatMap((file): SearchPanelRow[] => [
          { kind: "file", file },
          ...(file.uniqueLineCount === undefined
            ? file.lines.map((line): SearchPanelRow => ({ kind: "line", file, line }))
            : [
                {
                  kind: "summary",
                  text: `${String(file.uniqueLineCount)} unique line texts · search this path with a narrower query`,
                } satisfies SearchPanelRow,
                ...(file.groups ?? []).map((group): SearchPanelRow => ({
                  kind: "summary",
                  text: `×${String(group.matchCount)} ${group.text}`,
                })),
              ]),
        ]);

  if (expanded || rows.length <= COMPACT_SEARCH_ROWS) {
    return rows;
  }

  const selected = rows.slice(0, COMPACT_SEARCH_ROWS - 1);

  while (selected.at(-1)?.kind === "file") {
    selected.pop();
  }

  const shownIds = new Set(
    selected.flatMap((row) => (row.kind === "line" ? (row.line.logicalMatchIds ?? []) : [])),
  );
  const shownMatches =
    shownIds.size > 0
      ? shownIds.size
      : selected.reduce((count, row) => count + (row.kind === "line" ? row.line.matchCount : 0), 0);
  return [
    ...selected,
    { kind: "omitted", matches: Math.max(0, details.matchCount - shownMatches) },
  ];
}

function searchSummary(details: SearchToolDetails): string {
  if (details.matchCount === 0) {
    return details.complete ? "No matches" : "No matches · incomplete";
  }

  const count = `${String(details.matchCount)}${details.complete ? "" : "+"}`;
  return `${count} ${plural(details.matchCount, "match", "matches")} in ${String(details.fileCount)} ${plural(
    details.fileCount,
    "file",
    "files",
  )}`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
