import { requiredValue } from "pi-agent-invariant";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { preserveEnclosingBackground } from "pi-agent-tool-ui";

import { createDiffThemePalette, type DiffThemePalette, type DiffThemeTone } from "./diff-theme.ts";
import { compactViewport, expandedViewport, type ViewportRow } from "./diff-viewport.ts";

import type { DiffModel, DiffRow, DiffTextRange } from "./diff-model.ts";

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
      `   ··· ${String(omitted)} lines omitted${item.omittedChanged ? ` (${item.omittedChanged} changed)` : ""}`,
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
  const cursor = resource.cursor;
  const cursorColumn =
    cursor !== undefined && cursor.line === row.afterLine && row.kind !== "removed"
      ? cursor.column
      : undefined;
  const shown = visibleRowText(row, cursorColumn);
  const isWhole = shown.start === 0 && shown.end === row.text.length;
  let content =
    (isWhole ? resource.highlightedRows.get(row) : undefined) ??
    shown.text.replaceAll("\t", " ".repeat(4));

  if (row.kind === "modified") {
    content = highlightRanges(
      content,
      shown.text,
      shown.addedRanges,
      palette.modified,
      shown.deletedOffsets,
    );
  }

  if (cursorColumn !== undefined) {
    content = insertCursor(
      content,
      expandedOffset(shown.text, cursorColumn - shown.start),
      theme.fg("accent", "▌"),
    );
  }

  if (!isWhole) {
    const hidden = (row.text.length - shown.text.length).toLocaleString("en-US");
    // Attached to the text, so wrapping cannot leave an ellipsis alone on the first line.
    const before = shown.start > 0 ? "…" : "";
    const after = `${shown.end < row.text.length ? "…" : ""} (${hidden} characters not shown)`;
    content = `${before && withForeground(palette.contextForeground, before)}${content}${withForeground(palette.contextForeground, after)}`;
  }

  const contentWidth = Math.max(1, innerWidth - 1 - visibleWidth(gutter));
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  const continuationGutter = " ".repeat(gutter.length);

  return wrapped.map((line, index) => `${index === 0 ? styledGutter : continuationGutter}${line}`);
}

/**
 * Longest row text a panel shows in full. Wrapping and styling cost grows with the text, and a
 * minified file can hold megabytes on one line; a longer row shows a window of this many
 * characters around its first change or the cursor.
 */
export const MAX_ROW_CHARACTERS = 2_000;

interface VisibleRowText {
  readonly text: string;
  /** Offsets of the window in the row's text. */
  readonly start: number;
  readonly end: number;
  /** Change ranges and deletion offsets relative to the window. */
  readonly addedRanges: readonly DiffTextRange[];
  readonly deletedOffsets: readonly number[];
}

function visibleRowText(row: DiffRow, cursorColumn: number | undefined): VisibleRowText {
  const { text } = row;
  const addedRanges = row.addedRanges ?? [];
  const deletedOffsets = row.deletedOffsets ?? [];
  if (text.length <= MAX_ROW_CHARACTERS) {
    return { text, start: 0, end: text.length, addedRanges, deletedOffsets };
  }
  const focus = cursorColumn ?? addedRanges[0]?.from ?? deletedOffsets[0] ?? 0;
  let start = Math.min(
    Math.max(0, focus - Math.floor(MAX_ROW_CHARACTERS / 4)),
    text.length - MAX_ROW_CHARACTERS,
  );
  let end = start + MAX_ROW_CHARACTERS;
  // Keep surrogate pairs whole at both edges.
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  if (isLowSurrogate(text.charCodeAt(end))) end--;
  return {
    text: text.slice(start, end),
    start,
    end,
    addedRanges: addedRanges.flatMap(({ from, to }) =>
      to <= start || from >= end
        ? []
        : [{ from: Math.max(from, start) - start, to: Math.min(to, end) - start }],
    ),
    deletedOffsets: deletedOffsets.flatMap((offset) =>
      offset < start || offset > end ? [] : [offset - start],
    ),
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc_00 && code <= 0xdf_ff;
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
  deletedOffsets: readonly number[],
): string {
  const expandedRanges = mergeRanges([
    ...ranges,
    ...deletionWordRanges(source, deletedOffsets),
  ]).map(({ from, to }) => ({
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

function deletionWordRanges(source: string, offsets: readonly number[]): readonly DiffTextRange[] {
  const words = [...source.matchAll(/[\p{L}\p{M}\p{N}_$]+/gu)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
  return offsets.flatMap((offset) => {
    const word = words.find(({ to }) => to > offset) ?? words.at(-1);
    return word === undefined ? [] : [word];
  });
}

function mergeRanges(ranges: readonly DiffTextRange[]): readonly DiffTextRange[] {
  const merged: DiffTextRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.from - right.from)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      merged[merged.length - 1] = { from: previous.from, to: Math.max(previous.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
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
