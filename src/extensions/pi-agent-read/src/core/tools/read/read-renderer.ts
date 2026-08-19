import {
    type AgentToolResult,
    getLanguageFromPath,
    getMarkdownTheme,
    highlightCode,
    keyHint,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTextSourceLine } from "pi-agent-text";

import type { ReadResultRendererOptions } from "#src/api/rendering.js";
import type { ReadResultDetails, ReadResultRenderer, ReadTextLine } from "#src/api/tools/read.js";

export const COMPACT_READ_ROWS = 12;

interface ReadPanelState
{
    readonly result: AgentToolResult<unknown>;
    readonly details: ReadResultDetails;
    readonly options: ReadResultRendererOptions;
    readonly expanded: boolean;
    readonly theme: Theme;
}

export function createReadResultRenderer(options: ReadResultRendererOptions): ReadResultRenderer
{
    return (result, renderOptions, theme, context): Component =>
    {
        if (renderOptions.isPartial || context.isError)
        {
            const text = textBlocks(result);
            const color = context.isError ? "error" : "dim";
            return new Text(theme.fg(color, text), 0, 0);
        }

        if (!hasTextContent(result))
        {
            return context.lastComponent instanceof Container ? context.lastComponent : new Container();
        }

        const details = readDetails(result.details);
        const previous = context.lastComponent instanceof ReadResultPanel ? context.lastComponent : undefined;
        const panel = previous ?? new ReadResultPanel({
            result,
            details,
            options,
            expanded: renderOptions.expanded,
            theme,
        });
        panel.update({ result, details, options, expanded: renderOptions.expanded, theme });
        return panel;
    };
}

export class ReadResultPanel implements Component
{
    private cached: { readonly width: number; readonly lines: string[]; } | undefined;

    public constructor(private state: ReadPanelState)
    {}

    public update(state: ReadPanelState): void
    {
        if (
            this.state.result !== state.result
            || this.state.details !== state.details
            || this.state.options !== state.options
            || this.state.expanded !== state.expanded
            || this.state.theme !== state.theme
        )
        {
            this.state = state;
            this.invalidate();
        }
    }

    public render(width: number): string[]
    {
        if (this.cached?.width === width)
        {
            return this.cached.lines;
        }

        if (width < 8)
        {
            const lines = [truncateToWidth(readTitle(this.state, width), Math.max(1, width))];
            this.cached = { width, lines };
            return lines;
        }

        const innerWidth = width - 2;
        const contentWidth = Math.max(1, innerWidth - 2);
        const renderedRows = renderContentRows(this.state, contentWidth);
        const rows = compactRows(renderedRows, this.state.expanded, this.state.theme);
        const lines = [renderTopBorder(this.state, innerWidth, this.state.theme)];

        for (const row of rows)
        {
            lines.push(framed(row, innerWidth, this.state.theme));
        }

        const status = readStatus(this.state.details, this.state.theme);

        if (status !== undefined)
        {
            lines.push(framed(status, innerWidth, this.state.theme));
        }

        lines.push(this.state.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`));
        const clipped = lines.map((line) => truncateToWidth(line, width));
        this.cached = { width, lines: clipped };
        return clipped;
    }

    public invalidate(): void
    {
        this.cached = undefined;
    }
}

function renderContentRows(state: ReadPanelState, width: number): string[]
{
    const lines = readLines(state.details);
    const text = cleanText(state.result, lines, state.details);

    if (state.options.kind === "markdown" || isMarkdownSource(state.details, lines, state.options.kind))
    {
        const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
        return nonEmptyRows(markdown.render(width), state.theme);
    }

    if (state.options.kind === "code-view")
    {
        const rows = lines === undefined
            ? text.split(/\r\n|\r|\n/u).map((line) => renderCodeViewLabel(line, state.theme))
            : renderCodeViewLines(lines, state.theme);
        return nonEmptyRows(rows, state.theme);
    }

    const sourceLines = lines?.map(({ content }) => normalizeText(content))
        ?? text.split(/\r\n|\r|\n/u).map(normalizeText);
    const language = languageFor(state.details, lines);
    const rows = language === undefined
        ? sourceLines.map((line) => state.theme.fg("toolOutput", line))
        : highlightCode(sourceLines.join("\n"), language);
    return nonEmptyRows(rows, state.theme);
}

function renderCodeViewLines(lines: readonly ReadTextLine[], theme: Theme): string[]
{
    return lines.map((line) =>
    {
        const sourceLine = getTextSourceLine(line);

        if (sourceLine === undefined)
        {
            return renderCodeViewLabel(line.content, theme);
        }

        const language = getLanguageFromPath(sourceLine.source);
        const content = normalizeText(stripScopeMarkers(line.content));
        return language === undefined
            ? theme.fg("toolOutput", content)
            : highlightCode(content, language)[0] ?? theme.fg("toolOutput", content);
    });
}

function stripScopeMarkers(value: string): string
{
    return value.replace(/(?:[ \t]{2,}<!--[ \t]+scope-(?:begin|end)-[^\s>]+[ \t]+-->)+[ \t]*$/u, "");
}

function renderCodeViewLabel(value: string, theme: Theme): string
{
    const line = normalizeText(stripScopeMarkers(value));

    if (/^#{2,3}\s/u.test(line))
    {
        return theme.fg("mdHeading", theme.bold(line.replace(/^#{2,3}\s+/u, "")));
    }

    if (/^(?:Lines|Reason|Recovery):/u.test(line))
    {
        return theme.fg("dim", line);
    }

    if (/^[\p{L}][^:]*:$/u.test(line))
    {
        return theme.fg("accent", theme.bold(line));
    }

    if (/^\s*[-*]\s/u.test(line))
    {
        return theme.fg("mdListBullet", line);
    }

    return theme.fg("toolOutput", line);
}

function compactRows(rows: readonly string[], expanded: boolean, theme: Theme): readonly string[]
{
    if (expanded || rows.length <= COMPACT_READ_ROWS)
    {
        return rows;
    }

    const shown = rows.slice(0, COMPACT_READ_ROWS - 1);
    const omitted = rows.length - shown.length;
    return [
        ...shown,
        `${theme.fg("dim", `… ${String(omitted)} more ${omitted === 1 ? "row" : "rows"} · `)}${
            keyHint("app.tools.expand", "to expand")
        }`,
    ];
}

function renderTopBorder(state: ReadPanelState, width: number, theme: Theme): string
{
    const frame = (text: string): string => theme.fg("borderMuted", text);
    const title = truncateToWidth(` ${readTitle(state, Math.max(1, width - 1))} `, Math.max(0, width - 1), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(title) - 1));
    return `${frame("╭─")}${title}${frame(`${fill}╮`)}`;
}

function readTitle(state: ReadPanelState, width: number): string
{
    const label = state.options.label ?? languageLabel(languageFor(state.details, readLines(state.details)));
    const source = state.details.source ?? "read result";
    const range = sourceRange(state.details);
    const prefix = state.theme.fg("accent", state.theme.bold(label));
    const suffix = range === undefined ? "" : state.theme.fg("dim", ` · ${range}`);
    const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix) - 2);
    const renderedSource = truncateFromStart(source, available);
    return `${prefix} ${state.theme.fg("muted", renderedSource)}${suffix}`;
}

function sourceRange(details: ReadResultDetails): string | undefined
{
    if (
        details.startLine === undefined
        || details.endLine === undefined
        || details.totalLines === undefined
        || details.totalLines <= 0
    )
    {
        return undefined;
    }

    return `${String(details.startLine)}–${String(details.endLine)} / ${String(details.totalLines)}`;
}

function readStatus(details: ReadResultDetails, theme: Theme): string | undefined
{
    const truncation = details.truncation;

    if (truncation?.firstLineExceedsLimit === true)
    {
        return theme.fg("warning", "First source line is larger than the saved read limit");
    }

    if (truncation?.truncated === true)
    {
        return theme.fg(
            "warning",
            `Saved result contains ${String(truncation.outputLines)} of ${String(truncation.totalLines)} rendered rows`,
        );
    }

    return undefined;
}

function framed(content: string, width: number, theme: Theme): string
{
    const contentWidth = Math.max(0, width - 2);
    const clipped = truncateToWidth(content, contentWidth);
    const body = ` ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} `;
    const border = theme.fg("borderMuted", "│");
    return `${border}${body}${border}`;
}

function cleanText(
    result: AgentToolResult<unknown>,
    lines: readonly ReadTextLine[] | undefined,
    details: ReadResultDetails,
): string
{
    if (lines !== undefined)
    {
        return lines.map((line) => `${line.content}${line.lineEnding}`).join("");
    }

    const text = textBlocks(result);

    if (
        details.truncation === undefined
        && !(details.totalLines !== undefined && details.endLine !== undefined && details.endLine < details.totalLines)
    )
    {
        return text;
    }

    return text.replace(/\n\n\[(?:Showing lines|Output truncated|\d+ more lines in source)[\s\S]*\]$/u, "");
}

function textBlocks(result: AgentToolResult<unknown>): string
{
    return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function readLines(details: ReadResultDetails): readonly ReadTextLine[] | undefined
{
    return details.lines;
}

function readDetails(value: unknown): ReadResultDetails
{
    return typeof value === "object" && value !== null ? value : {};
}

function hasTextContent(result: AgentToolResult<unknown>): boolean
{
    return result.content.some((block) => block.type === "text");
}

function languageFor(details: ReadResultDetails, lines: readonly ReadTextLine[] | undefined): string | undefined
{
    const mappedSource = lines?.map(getTextSourceLine).find((line) => line !== undefined)?.source;
    const source = mappedSource ?? details.source;
    return source === undefined ? undefined : getLanguageFromPath(normalizeSourcePath(source));
}

function isMarkdownSource(
    details: ReadResultDetails,
    lines: readonly ReadTextLine[] | undefined,
    kind: ReadResultRendererOptions["kind"],
): boolean
{
    return kind === "source" && languageFor(details, lines) === "markdown";
}

function normalizeSourcePath(source: string): string
{
    try
    {
        const url = new URL(source);
        return url.protocol === "file:" ? url.pathname : `${url.pathname}${url.search}`;
    }
    catch
    {
        const withoutSelector = source.replace(/#[^/\\]*$/u, "");
        return withoutSelector.replace(/^[A-Za-z][A-Za-z\d+.-]*:(?=[/\\])/u, "");
    }
}

function normalizeText(value: string): string
{
    let output = "";

    for (const character of value.replaceAll("\t", "    "))
    {
        const code = character.codePointAt(0)!;
        output += code < 0x20 || code === 0x7F ? "�" : character;
    }

    return output;
}

function languageLabel(language: string | undefined): string
{
    const labels: Readonly<Record<string, string>> = {
        javascript: "JS",
        json: "JSON",
        markdown: "MD",
        python: "PY",
        rust: "RS",
        typescript: "TS",
    };
    return language === undefined ? "TEXT" : labels[language] ?? language.slice(0, 4).toUpperCase();
}

function nonEmptyRows(rows: readonly string[], theme: Theme): string[]
{
    return rows.length === 0 ? [theme.fg("dim", "Empty content")] : [...rows];
}

function truncateFromStart(value: string, width: number): string
{
    if (visibleWidth(value) <= width)
    {
        return value;
    }

    if (width <= 1)
    {
        return "…";
    }

    return `…${value.slice(-(width - 1))}`;
}
