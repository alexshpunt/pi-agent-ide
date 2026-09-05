import { requiredValue } from "pi-agent-invariant";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { preserveEnclosingBackground } from "pi-agent-tool-ui";

import { createDiffThemePalette, type DiffThemePalette, type DiffThemeTone } from "./diff-theme.js";
import { compactViewport, expandedViewport, type ViewportRow } from "./diff-viewport.js";

import type { DiffModel, DiffRow, DiffTextRange } from "./diff-model.js";

export interface DiffPanelResource {
  readonly path: string;
  readonly link?: string;
  readonly model: DiffModel;
  readonly highlightedRows: ReadonlyMap<DiffRow, string>;
  readonly cursor?: { readonly line: number; readonly column: number };
}

/** Renders one diff panel, reusing rendered rows when their identity is stable. */
export function renderDiffPanel(
  resource: DiffPanelResource,
  width: number,
  theme: Theme,
  expanded: boolean,
  pending: boolean,
  rowCache?: Map<DiffRow, readonly string[]>,
  showResourceLabel = false,
): string[] {
  const panelWidth = Math.max(20, width);
  const innerWidth = panelWidth - 2;
  const palette = createDiffThemePalette(theme, pending);
  const styleFrame = (text: string): string => theme.fg("borderMuted", text);
  const lines = [renderTopBorder(resource, innerWidth, theme, styleFrame, showResourceLabel)];
  const viewport = expanded ? expandedViewport(resource.model) : compactViewport(resource.model);
  let greatestLine = 0;

  for (const row of resource.model.rows) {
    greatestLine = Math.max(greatestLine, row.beforeLine ?? 0, row.afterLine ?? 0);
  }

  const gutterWidth = Math.max(3, String(greatestLine).length);
  let isExpandHintShown = false;

  for (const row of viewport) {
    const isShowExpandHint: boolean = !expanded && row.omitted !== undefined && !isExpandHintShown;

    if (isShowExpandHint) {
      isExpandHintShown = true;
    }

    const tone = diffTone(row.row?.kind, palette);
    const background =
      tone === undefined
        ? undefined
        : (text: string) => withBackground(tone.background, text, palette.restoreBackground);
    const hasCursor =
      row.row !== undefined &&
      resource.cursor !== undefined &&
      resource.cursor.line === row.row.afterLine &&
      row.row.kind !== "removed";
    const cached = row.row === undefined || hasCursor ? undefined : rowCache?.get(row.row);

    if (cached !== undefined) {
      lines.push(...cached);
      continue;
    }

    const framedLines = renderRow(
      row,
      resource,
      gutterWidth,
      innerWidth,
      theme,
      palette,
      isShowExpandHint,
    ).map((renderedRow) => framed(renderedRow, innerWidth, styleFrame, background));

    if (row.row !== undefined && !hasCursor) {
      rowCache?.set(row.row, framedLines);
    }
    lines.push(...framedLines);
  }

  lines.push(styleFrame(border("╰", "─", "╯", innerWidth)));
  return lines;
}

function renderRow(
  item: ViewportRow,
  resource: DiffPanelResource,
  gutterWidth: number,
  innerWidth: number,
  theme: Theme,
  palette: DiffThemePalette,
  showExpandHint: boolean,
): readonly string[] {
  const omitted = item.omitted ?? item.row?.omitted;

  if (omitted !== undefined) {
    const summary = withForeground(
      palette.contextForeground,
      `   ··· ${String(omitted)} lines omitted`,
    );
    return [
      showExpandHint
        ? `${summary}${withForeground(palette.contextForeground, " · ")}${keyHint(
            "app.tools.expand",
            "to expand",
          )}${withForeground(palette.contextForeground, " ···")}`
        : `${summary}${withForeground(palette.contextForeground, " ···")}`,
    ];
  }

  if (item.row === undefined) {
    return [""];
  }

  const row = item.row;
  const number = String(
    row.kind === "removed" ? (row.beforeLine ?? "") : (row.afterLine ?? ""),
  ).padStart(gutterWidth);
  const marker =
    row.kind === "added" ? "+" : row.kind === "removed" ? "-" : row.kind === "modified" ? "~" : " ";
  const gutter = `${number} ${marker} `;
  const tone = diffTone(row.kind, palette);
  const styledGutter = withForeground(tone?.foreground ?? palette.contextForeground, gutter);
  let content = resource.highlightedRows.get(row) ?? row.text.replaceAll("\t", " ".repeat(4));

  if (row.kind === "modified") {
    content = highlightRanges(content, row.text, row.addedRanges ?? [], palette.modified);
  }

  const cursor = resource.cursor;

  if (cursor !== undefined && cursor.line === row.afterLine && row.kind !== "removed") {
    content = insertCursor(
      content,
      expandedOffset(row.text, cursor.column),
      theme.fg("accent", "▌"),
    );
  }

  const contentWidth = Math.max(1, innerWidth - 1 - visibleWidth(gutter));
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  const continuationGutter = " ".repeat(gutter.length);

  return wrapped.map((line, index) => `${index === 0 ? styledGutter : continuationGutter}${line}`);
}

function diffTone(
  kind: DiffRow["kind"] | undefined,
  palette: DiffThemePalette,
): DiffThemeTone | undefined {
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
): string {
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
  let isHighlighting = false;

  while (sourceIndex < highlighted.length) {
    const ansi = ansiSequenceAt(highlighted, sourceIndex);

    if (ansi !== undefined) {
      rendered += ansi;

      if (isHighlighting) {
        rendered += changedBackground;
      }

      sourceIndex += ansi.length;
      continue;
    }

    if (isHighlighting && expandedRanges[rangeIndex]?.to === visibleOffset) {
      rendered += editingBackground;
      isHighlighting = false;
      rangeIndex++;
    }

    if (!isHighlighting && expandedRanges[rangeIndex]?.from === visibleOffset) {
      rendered += changedBackground;
      isHighlighting = true;
    }

    rendered += highlighted[sourceIndex];
    sourceIndex++;
    visibleOffset++;
  }

  if (isHighlighting) {
    rendered += editingBackground;
  }

  return rendered;
}

function ansiSequenceAt(text: string, index: number): string | undefined {
  if (text[index] !== "\u{1B}" || text[index + 1] !== "[") {
    return undefined;
  }

  for (let end = index + 2; end < text.length; end++) {
    const code = requiredValue(text.codePointAt(end));

    if (code >= 0x40 && code <= 0x7e) {
      return text.slice(index, end + 1);
    }
  }

  return undefined;
}

function insertCursor(text: string, offset: number, cursor: string): string {
  let visibleOffset = 0;

  for (let index = 0; index < text.length;) {
    if (visibleOffset === offset) {
      return `${text.slice(0, index)}${cursor}${text.slice(index)}`;
    }

    const ansi = ansiSequenceAt(text, index);

    if (ansi === undefined) {
      index++;
      visibleOffset++;
    } else {
      index += ansi.length;
    }
  }

  return `${text}${cursor}`;
}

function expandedOffset(text: string, offset: number): number {
  return text.slice(0, offset).replaceAll("\t", " ".repeat(4)).length;
}

function renderTopBorder(
  resource: DiffPanelResource,
  width: number,
  theme: Theme,
  styleFrame: (text: string) => string,
  showResourceLabel: boolean,
): string {
  if (!showResourceLabel) {
    return styleFrame(border("╭", "─", "╮", width));
  }

  const displayedPath = truncateToWidth(resource.path, Math.max(1, width - 3));
  const label = renderResourcePath(displayedPath, resource.link, theme);
  const title = ` ${label} `;
  const fill = "─".repeat(Math.max(0, width - visibleWidth(title) - 1));
  return `${styleFrame("╭─")}${title}${styleFrame(`${fill}╮`)}`;
}

function renderResourcePath(path: string, link: string | undefined, theme: Theme): string {
  const label = theme.underline(theme.fg("accent", path));
  return link === undefined || link.includes("\u{7}") || link.includes("\u{1B}")
    ? label
    : `\u{1B}]8;;${link}\u{7}${label}\u{1B}]8;;\u{7}`;
}

function framed(
  content: string,
  width: number,
  styleFrame: (text: string) => string,
  background?: (text: string) => string,
): string {
  const clipped = truncateToWidth(` ${content}`, width);
  const body = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  return `${styleFrame("│")}${background?.(body) ?? body}${styleFrame("│")}`;
}

function withForeground(ansi: string, text: string): string {
  return `${ansi}${text}\u{1B}[39m`;
}

function withBackground(ansi: string, text: string, restoreBackground: string): string {
  return `${ansi}${preserveEnclosingBackground(text, ansi)}${restoreBackground}`;
}

function border(left: string, fill: string, right: string, width: number): string {
  return `${left}${fill.repeat(width)}${right}`;
}

export function changedRows(model: DiffModel): readonly DiffRow[] {
  return model.rows.filter((row) => row.changed);
}
