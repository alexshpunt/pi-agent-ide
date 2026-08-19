import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createDiffThemePalette, type DiffThemePalette, type DiffThemeTone } from "./diff-theme.js";
import { compactViewport, expandedViewport, type ViewportRow } from "./diff-viewport.js";

import type { DiffModel, DiffRow, DiffTextRange } from "./diff-model.js";

export interface DiffPanelResource
{
    readonly path: string;
    readonly link?: string;
    readonly model: DiffModel;
    readonly highlightedRows: ReadonlyMap<DiffRow, string>;
    readonly cursor?: { readonly line: number; readonly column: number; };
}

export function renderDiffPanel(
    resource: DiffPanelResource,
    width: number,
    theme: Theme,
    expanded: boolean,
    pending: boolean,
): string[]
{
    const panelWidth = Math.max(20, width);
    const innerWidth = panelWidth - 2;
    const palette = createDiffThemePalette(theme, pending);
    const styleFrame = (text: string): string => theme.fg("borderMuted", text);
    const lines = [styleFrame(border("╭", "─", "╮", innerWidth))];
    const viewport = expanded ? expandedViewport(resource.model) : compactViewport(resource.model);
    let greatestLine = 0;

    for (const row of resource.model.rows)
    {
        greatestLine = Math.max(greatestLine, row.beforeLine ?? 0, row.afterLine ?? 0);
    }

    const gutterWidth = Math.max(3, String(greatestLine).length);
    let expandHintShown = false;

    for (const row of viewport)
    {
        const showExpandHint: boolean = !expanded && row.omitted !== undefined && !expandHintShown;

        if (showExpandHint)
        {
            expandHintShown = true;
        }

        const tone = diffTone(row.row?.kind, palette);
        const background = tone === undefined
            ? undefined
            : (text: string) => withBackground(tone.background, text, palette.restoreBackground);
        lines.push(framed(
            renderRow(row, resource, gutterWidth, theme, palette, showExpandHint),
            innerWidth,
            styleFrame,
            background,
        ));
    }

    lines.push(styleFrame(border("╰", "─", "╯", innerWidth)));
    return lines.map((line) => truncateToWidth(line, panelWidth));
}

function renderRow(
    item: ViewportRow,
    resource: DiffPanelResource,
    gutterWidth: number,
    theme: Theme,
    palette: DiffThemePalette,
    showExpandHint: boolean,
): string
{
    const omitted = item.omitted ?? item.row?.omitted;

    if (omitted !== undefined)
    {
        const summary = withForeground(palette.contextForeground, `   ··· ${String(omitted)} lines omitted`);
        return showExpandHint
            ? `${summary}${withForeground(palette.contextForeground, " · ")}${
                keyHint("app.tools.expand", "to expand")
            }${withForeground(palette.contextForeground, " ···")}`
            : `${summary}${withForeground(palette.contextForeground, " ···")}`;
    }

    if (item.row === undefined)
    {
        return "";
    }

    const row = item.row;
    const number = String(row.kind === "removed" ? row.beforeLine ?? "" : row.afterLine ?? "").padStart(gutterWidth);
    const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "-" : row.kind === "modified" ? "~" : " ";
    const gutter = `${number} ${marker} `;
    const tone = diffTone(row.kind, palette);
    const styledGutter = withForeground(tone?.foreground ?? palette.contextForeground, gutter);
    let content = resource.highlightedRows.get(row) ?? row.text.replaceAll("\t", "    ");

    if (row.kind === "modified")
    {
        content = highlightRanges(content, row.text, row.addedRanges ?? [], palette.modified);
    }

    const cursor = resource.cursor;

    if (cursor !== undefined && cursor.line === row.afterLine && row.kind !== "removed")
    {
        content = insertCursor(content, expandedOffset(row.text, cursor.column), theme.fg("accent", "▌"));
    }

    return `${styledGutter}${content}`;
}

function diffTone(kind: DiffRow["kind"] | undefined, palette: DiffThemePalette): DiffThemeTone | undefined
{
    return kind === "added"
        ? palette.added
        : kind === "removed"
        ? palette.removed
        : kind === "modified"
        ? palette.modified
        : undefined;
}

function highlightRanges(
    highlighted: string,
    source: string,
    ranges: readonly DiffTextRange[],
    tone: DiffThemeTone,
): string
{
    const expandedRanges = ranges.map(({ from, to }) => ({
        from: expandedOffset(source, from),
        to: expandedOffset(source, to),
    }));
    const changedBackground = tone.emphasisBackground;
    const editingBackground = tone.background;
    let rendered = "";
    let sourceIndex = 0;
    let visibleOffset = 0;
    let rangeIndex = 0;
    let highlighting = false;

    while (sourceIndex < highlighted.length)
    {
        const ansi = ansiSequenceAt(highlighted, sourceIndex);

        if (ansi !== undefined)
        {
            rendered += ansi;

            if (highlighting)
            {
                rendered += changedBackground;
            }

            sourceIndex += ansi.length;
            continue;
        }

        if (highlighting && expandedRanges[rangeIndex]?.to === visibleOffset)
        {
            rendered += editingBackground;
            highlighting = false;
            rangeIndex++;
        }

        if (!highlighting && expandedRanges[rangeIndex]?.from === visibleOffset)
        {
            rendered += changedBackground;
            highlighting = true;
        }

        rendered += highlighted[sourceIndex]!;
        sourceIndex++;
        visibleOffset++;
    }

    if (highlighting)
    {
        rendered += editingBackground;
    }

    return rendered;
}

function ansiSequenceAt(text: string, index: number): string | undefined
{
    if (text[index] !== "\u001B" || text[index + 1] !== "[")
    {
        return undefined;
    }

    for (let end = index + 2; end < text.length; end++)
    {
        const code = text.codePointAt(end)!;

        if (code >= 0x40 && code <= 0x7E)
        {
            return text.slice(index, end + 1);
        }
    }

    return undefined;
}

function insertCursor(text: string, offset: number, cursor: string): string
{
    let visibleOffset = 0;

    for (let index = 0; index < text.length;)
    {
        if (visibleOffset === offset)
        {
            return `${text.slice(0, index)}${cursor}${text.slice(index)}`;
        }

        const ansi = ansiSequenceAt(text, index);

        if (ansi === undefined)
        {
            index++;
            visibleOffset++;
        }
        else
        {
            index += ansi.length;
        }
    }

    return `${text}${cursor}`;
}

function expandedOffset(text: string, offset: number): number
{
    return text.slice(0, offset).replaceAll("\t", "    ").length;
}

function framed(
    content: string,
    width: number,
    styleFrame: (text: string) => string,
    background?: (text: string) => string,
): string
{
    const clipped = truncateToWidth(` ${content}`, width);
    const body = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
    return `${styleFrame("│")}${background?.(body) ?? body}${styleFrame("│")}`;
}

function withForeground(ansi: string, text: string): string
{
    return `${ansi}${text}\u001B[39m`;
}

function withBackground(ansi: string, text: string, restoreBackground: string): string
{
    return `${ansi}${text}${restoreBackground}`;
}

function border(left: string, fill: string, right: string, width: number): string
{
    return `${left}${fill.repeat(width)}${right}`;
}

export function changedRows(model: DiffModel): readonly DiffRow[]
{
    return model.rows.filter((row) => row.changed);
}
