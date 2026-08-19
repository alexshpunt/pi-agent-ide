import path from "node:path";

import {
    type AgentToolResult,
    keyText,
    type Theme,
    type ThemeColor,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isSearchToolDetails } from "#src/search-result.js";

import type { SearchResultFile, SearchResultLine, SearchResultRange, SearchToolDetails } from "#src/search-result.js";

const COMPACT_SEARCH_ROWS = 12;

const FILE_BADGES: Readonly<Record<string, { readonly label: string; readonly color: ThemeColor; }>> = {
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

interface SearchCallArguments
{
    readonly query?: unknown;
    readonly path?: unknown;
}

interface SearchRenderContext
{
    readonly lastComponent: Component | undefined;
    readonly isError?: boolean;
}

type SearchPanelRow =
    | { readonly kind: "file"; readonly file: SearchResultFile; }
    | { readonly kind: "line"; readonly file: SearchResultFile; readonly line: SearchResultLine; }
    | { readonly kind: "omitted"; readonly matches: number; }
    | { readonly kind: "empty"; };

interface SearchLineWindow
{
    readonly from: number;
    readonly to: number;
    readonly leadingEllipsis: boolean;
    readonly trailingEllipsis: boolean;
}

export function renderSearchCall(args: SearchCallArguments, theme: Theme): Component
{
    const query = typeof args.query === "string" ? args.query : "";
    const scope = typeof args.path === "string" && args.path.length > 0 && args.path !== "."
        ? ` in ${args.path}`
        : "";
    return new Text(
        theme.fg("toolTitle", theme.bold("search "))
            + theme.fg("muted", `${JSON.stringify(query)}${scope}`),
        0,
        0,
    );
}

export function renderSearchResult(
    result: AgentToolResult<SearchToolDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: SearchRenderContext,
): Component
{
    if (options.isPartial || context.isError || !isSearchToolDetails(result.details))
    {
        const content = result.content[0];
        const text = content?.type === "text" ? content.text : "";
        const color: ThemeColor = context.isError ? "error" : options.isPartial ? "dim" : "toolOutput";
        return new Text(theme.fg(color, text), 0, 0);
    }

    const previous = context.lastComponent instanceof SearchResultPanel ? context.lastComponent : undefined;
    const panel = previous ?? new SearchResultPanel(result.details, theme, options.expanded);
    panel.update(result.details, theme, options.expanded);
    return panel;
}

export class SearchResultPanel implements Component
{
    private cached: { readonly width: number; readonly lines: string[]; } | undefined;

    public constructor(
        private details: SearchToolDetails,
        private theme: Theme,
        private expanded: boolean,
    )
    {}

    public update(details: SearchToolDetails, theme: Theme, expanded: boolean): void
    {
        if (this.details !== details || this.theme !== theme || this.expanded !== expanded)
        {
            this.details = details;
            this.theme = theme;
            this.expanded = expanded;
            this.invalidate();
        }
    }

    public render(width: number): string[]
    {
        if (this.cached?.width === width)
        {
            return this.cached.lines;
        }

        if (width < 4)
        {
            const lines = [truncateToWidth(searchSummary(this.details), Math.max(1, width))];
            this.cached = { width, lines };
            return lines;
        }

        const innerWidth = width - 2;
        const rows = searchViewport(this.details, this.expanded);
        const gutterWidth = maximumLineNumberWidth(this.details.files);
        const lines = [renderTopBorder(this.details, innerWidth, this.theme)];

        for (const row of rows)
        {
            lines.push(renderPanelRow(row, innerWidth, gutterWidth, this.theme));
        }

        lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`));
        const clipped = lines.map((line) => truncateToWidth(line, width));
        this.cached = { width, lines: clipped };
        return clipped;
    }

    public invalidate(): void
    {
        this.cached = undefined;
    }
}

function searchViewport(details: SearchToolDetails, expanded: boolean): readonly SearchPanelRow[]
{
    const rows = details.files.length === 0
        ? [{ kind: "empty" } satisfies SearchPanelRow]
        : details.files.flatMap((file): SearchPanelRow[] => [
            { kind: "file", file },
            ...file.lines.map((line): SearchPanelRow => ({ kind: "line", file, line })),
        ]);

    if (expanded || rows.length <= COMPACT_SEARCH_ROWS)
    {
        return rows;
    }

    const selected = rows.slice(0, COMPACT_SEARCH_ROWS - 1);

    while (selected.at(-1)?.kind === "file")
    {
        selected.pop();
    }

    const shownMatches = selected.reduce(
        (count, row) => count + (row.kind === "line" ? row.line.matchCount : 0),
        0,
    );
    return [...selected, { kind: "omitted", matches: details.matchCount - shownMatches }];
}

function renderPanelRow(row: SearchPanelRow, width: number, gutterWidth: number, theme: Theme): string
{
    if (row.kind === "file")
    {
        return framed(renderFileHeader(row.file, width, theme), width, theme, true);
    }

    if (row.kind === "line")
    {
        return framed(renderMatchLine(row.line, width, gutterWidth, theme), width, theme);
    }

    if (row.kind === "omitted")
    {
        const hint = `${keyText("app.tools.expand")} to expand`;
        return framed(
            theme.fg("dim", `  … ${String(row.matches)} more ${plural(row.matches, "match", "matches")} · ${hint}`),
            width,
            theme,
        );
    }

    return framed(theme.fg("dim", "  No matches found"), width, theme);
}

function renderFileHeader(file: SearchResultFile, width: number, theme: Theme): string
{
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

function renderMatchLine(line: SearchResultLine, width: number, gutterWidth: number, theme: Theme): string
{
    const number = String(line.lineNumber).padStart(gutterWidth);
    const gutter = ` ${theme.fg("dim", number)} ${theme.fg("borderMuted", "│")} `;
    const contentWidth = Math.max(1, width - visibleWidth(gutter) - 1);
    return `${gutter}${renderHighlightedLine(line, contentWidth, theme)}`;
}

function renderHighlightedLine(line: SearchResultLine, width: number, theme: Theme): string
{
    const window = searchLineWindow(line, width);
    const ranges = visibleRanges(line.ranges, window.from, window.to);
    let result = window.leadingEllipsis ? theme.fg("dim", "…") : "";
    let offset = window.from;

    for (const range of ranges)
    {
        if (range.from > offset)
        {
            result += theme.fg("toolOutput", safeText(line.text.slice(offset, range.from)));
        }

        const match = safeText(line.text.slice(range.from, range.to));
        result += theme.bg("selectedBg", theme.fg("accent", theme.bold(match)));
        offset = range.to;
    }

    if (offset < window.to)
    {
        result += theme.fg("toolOutput", safeText(line.text.slice(offset, window.to)));
    }

    if (window.trailingEllipsis)
    {
        result += theme.fg("dim", "…");
    }

    return truncateToWidth(result, width);
}

function searchLineWindow(line: SearchResultLine, width: number): SearchLineWindow
{
    if (visibleWidth(safeText(line.text)) <= width)
    {
        return { from: 0, to: line.text.length, leadingEllipsis: false, trailingEllipsis: false };
    }

    const focus = line.ranges[0]!;
    const budget = Math.max(1, width - 2);
    const matchWidth = Math.min(budget, Math.max(1, focus.to - focus.from));
    const before = Math.max(0, Math.floor((budget - matchWidth) * 0.4));
    let from = Math.max(0, focus.from - before);
    let to = Math.min(line.text.length, from + budget);

    if (to < focus.to)
    {
        to = Math.min(line.text.length, focus.to);
        from = Math.max(0, to - budget);
    }

    return {
        from,
        to,
        leadingEllipsis: from > 0,
        trailingEllipsis: to < line.text.length,
    };
}

function visibleRanges(
    ranges: readonly SearchResultRange[],
    from: number,
    to: number,
): readonly SearchResultRange[]
{
    const visible: SearchResultRange[] = [];

    for (const range of ranges)
    {
        const clipped = { from: Math.max(from, range.from), to: Math.min(to, range.to) };

        if (clipped.to <= clipped.from)
        {
            continue;
        }

        const previous = visible.at(-1);

        if (previous !== undefined && clipped.from <= previous.to)
        {
            visible[visible.length - 1] = { from: previous.from, to: Math.max(previous.to, clipped.to) };
        }
        else
        {
            visible.push(clipped);
        }
    }

    return visible;
}

function renderTopBorder(details: SearchToolDetails, width: number, theme: Theme): string
{
    const frame = (text: string): string => theme.fg("borderMuted", text);
    const title = truncateToWidth(` ${searchSummary(details)} `, Math.max(0, width - 1), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(title) - 1));
    return `${frame("╭─")}${theme.fg("accent", title)}${frame(`${fill}╮`)}`;
}

function searchSummary(details: SearchToolDetails): string
{
    if (details.matchCount === 0)
    {
        return "No matches";
    }

    const count = `${String(details.matchCount)}${details.complete ? "" : "+"}`;
    return `${count} ${plural(details.matchCount, "match", "matches")} in ${String(details.fileCount)} ${
        plural(details.fileCount, "file", "files")
    }`;
}

function framed(content: string, width: number, theme: Theme, highlighted = false): string
{
    const clipped = truncateToWidth(content, width);
    const body = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
    const renderedBody = highlighted ? theme.bg("selectedBg", body) : body;
    const border = theme.fg("borderMuted", "│");
    return `${border}${renderedBody}${border}`;
}

function fileBadge(filePath: string, theme: Theme): string
{
    const extension = path.extname(filePath).toLowerCase();
    const badge = FILE_BADGES[extension] ?? {
        label: "◇ ",
        color: extension.length === 0 ? "muted" : "accent",
    } satisfies { readonly label: string; readonly color: ThemeColor; };
    return theme.fg(badge.color, theme.bold(badge.label));
}

function fileLink(displayedPath: string, link: string, theme: Theme): string
{
    const separator = Math.max(displayedPath.lastIndexOf("/"), displayedPath.lastIndexOf("\\"));
    const directory = separator === -1 ? "" : displayedPath.slice(0, separator + 1);
    const basename = separator === -1 ? displayedPath : displayedPath.slice(separator + 1);
    const label = theme.fg("muted", directory) + theme.underline(theme.fg("accent", basename));
    return link.includes("\u0007") || link.includes("\u001B")
        ? label
        : `\u001B]8;;${link}\u0007${label}\u001B]8;;\u0007`;
}

function truncatePath(filePath: string, width: number): string
{
    if (visibleWidth(filePath) <= width)
    {
        return filePath;
    }

    if (width <= 1)
    {
        return "…";
    }

    return `…${filePath.slice(-(width - 1))}`;
}

function safeText(value: string): string
{
    let result = "";

    for (const character of value)
    {
        if (character === "\t")
        {
            result += "    ";
            continue;
        }

        const code = character.codePointAt(0)!;
        result += code < 0x20 || code === 0x7F ? "�" : character;
    }

    return result;
}

function maximumLineNumberWidth(files: readonly SearchResultFile[]): number
{
    let maximum = 1;

    for (const file of files)
    {
        for (const line of file.lines)
        {
            maximum = Math.max(maximum, line.lineNumber);
        }
    }

    return Math.max(3, String(maximum).length);
}

function plural(count: number, singular: string, pluralForm: string): string
{
    return count === 1 ? singular : pluralForm;
}
