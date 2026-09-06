import { requiredValue } from "pi-agent-invariant";
import path from "node:path";

import {
  type AgentToolResult,
  keyText,
  type Theme,
  type ThemeColor,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { isSearchToolDetails } from "#src/search-result.js";

import { restoreSearchDetails } from "#src/persisted-result.js";

const restoredDetails = new WeakMap<object, SearchToolDetails>();

import type { SearchResultFile, SearchResultLine, SearchToolDetails } from "#src/search-result.js";

const COMPACT_SEARCH_ROWS = 12;

const FILE_BADGES: Readonly<
  Record<string, { readonly label: string; readonly color: ThemeColor }>
> = {
  ".ts": { label: "TS", color: "accent" },
  ".tsx": { label: "TX", color: "accent" },
  ".js": { label: "JS", color: "warning" },
  ".jsx": { label: "JX", color: "warning" },
  ".json": { label: "{}", color: "warning" },
  ".md": { label: "MD", color: "mdHeading" },
  ".py": { label: "PY", color: "accent" },
  ".rs": { label: "RS", color: "accent" },
  ".go": { label: "GO", color: "accent" },
  ".css": { label: "CS", color: "accent" },
  ".html": { label: "<>", color: "accent" },
};

interface SearchRenderContext {
  readonly lastComponent: Component | undefined;
  readonly isError?: boolean;
}

type SearchPanelRow =
  | { readonly kind: "file"; readonly file: SearchResultFile }
  | { readonly kind: "line"; readonly file: SearchResultFile; readonly line: SearchResultLine }
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
  panel.update(result.details, theme, options.expanded);
  return panel;
}

export class SearchResultPanel implements Component {
  private cached: { readonly width: number; readonly lines: string[] } | undefined;

  public constructor(
    private details: SearchToolDetails,
    private theme: Theme,
    private expanded: boolean,
  ) {}

  public update(details: SearchToolDetails, theme: Theme, expanded: boolean): void {
    if (this.details === details && this.theme === theme && this.expanded === expanded) {
      return;
    }

    this.details = details;
    this.theme = theme;
    this.expanded = expanded;
    this.invalidate();
  }

  public render(width: number): string[] {
    if (this.cached?.width === width) {
      return this.cached.lines;
    }

    if (width < 4) {
      const lines = [truncateToWidth(searchSummary(this.details), Math.max(1, width))];
      this.cached = { width, lines };
      return lines;
    }

    const innerWidth = width - 2;
    const rows = searchViewport(this.details, this.expanded);
    const gutterWidth = maximumLineNumberWidth(this.details.files);
    const renderedRows = rows.flatMap((row) =>
      renderPanelRow(row, innerWidth, gutterWidth, this.theme),
    );
    const visibleRows = compactRenderedRows(renderedRows, this.expanded, innerWidth, this.theme);
    const lines = [renderTopBorder(this.details, innerWidth, this.theme), ...visibleRows];

    lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`));
    const clipped = lines.map((line) => truncateToWidth(line, width));
    this.cached = { width, lines: clipped };
    return clipped;
  }

  public invalidate(): void {
    this.cached = undefined;
  }
}

function searchViewport(details: SearchToolDetails, expanded: boolean): readonly SearchPanelRow[] {
  const rows =
    details.files.length === 0
      ? [{ kind: "empty" } satisfies SearchPanelRow]
      : details.files.flatMap((file): SearchPanelRow[] => [
          { kind: "file", file },
          ...file.lines.map((line): SearchPanelRow => ({ kind: "line", file, line })),
        ]);

  if (expanded || rows.length <= COMPACT_SEARCH_ROWS) {
    return rows;
  }

  const selected = rows.slice(0, COMPACT_SEARCH_ROWS - 1);

  while (selected.at(-1)?.kind === "file") {
    selected.pop();
  }

  const shownMatches = selected.reduce(
    (count, row) => count + (row.kind === "line" ? row.line.matchCount : 0),
    0,
  );
  return [...selected, { kind: "omitted", matches: details.matchCount - shownMatches }];
}

function compactRenderedRows(
  rows: readonly string[],
  expanded: boolean,
  width: number,
  theme: Theme,
): readonly string[] {
  if (expanded || rows.length <= COMPACT_SEARCH_ROWS) {
    return rows;
  }

  const hint = `${keyText("app.tools.expand")} to expand`;
  const notice = framed(theme.fg("dim", `  … output truncated · ${hint}`), width, theme);
  return [...rows.slice(0, COMPACT_SEARCH_ROWS - 1), notice];
}

function renderPanelRow(
  row: SearchPanelRow,
  width: number,
  gutterWidth: number,
  theme: Theme,
): readonly string[] {
  if (row.kind === "file") {
    return [framed(renderFileHeader(row.file, width, theme), width, theme, true)];
  }

  if (row.kind === "line") {
    return renderMatchLine(row.line, width, gutterWidth, theme);
  }

  if (row.kind === "omitted") {
    const hint = `${keyText("app.tools.expand")} to expand`;
    return [
      framed(
        theme.fg(
          "dim",
          `  … ${String(row.matches)} more ${plural(row.matches, "match", "matches")} · ${hint}`,
        ),
        width,
        theme,
      ),
    ];
  }

  return [framed(theme.fg("dim", "  No matches found"), width, theme)];
}

function renderFileHeader(file: SearchResultFile, width: number, theme: Theme): string {
  const badge = fileBadge(file.path, theme);
  const count = theme.fg("accent", theme.bold(String(file.matchCount)));
  const fixedWidth = visibleWidth(badge) + visibleWidth(count) + 4;
  const pathWidth = Math.max(1, width - fixedWidth);
  const displayedPath = truncatePath(file.path, pathWidth);
  const linkedPath = fileLink(displayedPath, file.link, theme);
  const left = ` ${badge} ${linkedPath}`;
  const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(count) - 1));
  return truncateToWidth(`${left}${gap}${count} `, width);
}

function renderMatchLine(
  line: SearchResultLine,
  width: number,
  gutterWidth: number,
  theme: Theme,
): readonly string[] {
  const number = String(line.lineNumber).padStart(gutterWidth);
  const gutter = ` ${theme.fg("dim", number)} ${theme.fg("borderMuted", "│")} `;
  const contentWidth = Math.max(1, width - visibleWidth(gutter) - 1);
  const wrapped = wrapTextWithAnsi(renderHighlightedLine(line, theme), contentWidth);
  const continuationGutter = " ".repeat(visibleWidth(gutter));

  return wrapped.map((content, index) =>
    framed(`${index === 0 ? gutter : continuationGutter}${content}`, width, theme),
  );
}

function renderHighlightedLine(line: SearchResultLine, theme: Theme): string {
  let result = "";
  let offset = 0;

  for (const range of line.ranges) {
    if (range.from > offset) {
      result += theme.fg("toolOutput", safeText(line.text.slice(offset, range.from)));
    }

    const match = safeText(line.text.slice(range.from, range.to));
    result += theme.bg("selectedBg", theme.fg("accent", theme.bold(match)));
    offset = range.to;
  }

  if (offset < line.text.length) {
    result += theme.fg("toolOutput", safeText(line.text.slice(offset)));
  }

  return result;
}
function renderTopBorder(details: SearchToolDetails, width: number, theme: Theme): string {
  const frame = (text: string): string => theme.fg("borderMuted", text);
  const title = truncateToWidth(` ${searchSummary(details)} `, Math.max(0, width - 1), "");
  const fill = "─".repeat(Math.max(0, width - visibleWidth(title) - 1));
  return `${frame("╭─")}${theme.fg("accent", title)}${frame(`${fill}╮`)}`;
}

function searchSummary(details: SearchToolDetails): string {
  if (details.matchCount === 0) {
    return "No matches";
  }

  const count = `${String(details.matchCount)}${details.complete ? "" : "+"}`;
  return `${count} ${plural(details.matchCount, "match", "matches")} in ${String(details.fileCount)} ${plural(
    details.fileCount,
    "file",
    "files",
  )}`;
}

function framed(content: string, width: number, theme: Theme, highlighted = false): string {
  const clipped = truncateToWidth(content, width);
  const body = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  const renderedBody = highlighted ? theme.bg("selectedBg", body) : body;
  const border = theme.fg("borderMuted", "│");
  return `${border}${renderedBody}${border}`;
}

function fileBadge(filePath: string, theme: Theme): string {
  const extension = path.extname(filePath).toLowerCase();
  const badge =
    FILE_BADGES[extension] ??
    ({
      label: "◇ ",
      color: extension.length === 0 ? "muted" : "accent",
    } satisfies { readonly label: string; readonly color: ThemeColor });
  return theme.fg(badge.color, theme.bold(badge.label));
}

function fileLink(displayedPath: string, link: string, theme: Theme): string {
  const separator = Math.max(displayedPath.lastIndexOf("/"), displayedPath.lastIndexOf("\\"));
  const directory = separator === -1 ? "" : displayedPath.slice(0, separator + 1);
  const basename = separator === -1 ? displayedPath : displayedPath.slice(separator + 1);
  const label = theme.fg("muted", directory) + theme.underline(theme.fg("accent", basename));
  return link.includes("\u{7}") || link.includes("\u{1B}")
    ? label
    : `\u{1B}]8;;${link}\u{7}${label}\u{1B}]8;;\u{7}`;
}

function truncatePath(filePath: string, width: number): string {
  if (visibleWidth(filePath) <= width) {
    return filePath;
  }

  if (width <= 1) {
    return "…";
  }

  return `…${filePath.slice(-(width - 1))}`;
}

function safeText(value: string): string {
  let result = "";

  for (const character of value) {
    if (character === "\t") {
      result += " ".repeat(4);
      continue;
    }

    const code = requiredValue(character.codePointAt(0));
    result += code < 0x20 || code === 0x7f ? "�" : character;
  }

  return result;
}

function maximumLineNumberWidth(files: readonly SearchResultFile[]): number {
  let maximum = 1;

  for (const file of files) {
    for (const line of file.lines) {
      maximum = Math.max(maximum, line.lineNumber);
    }
  }

  return Math.max(3, String(maximum).length);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
