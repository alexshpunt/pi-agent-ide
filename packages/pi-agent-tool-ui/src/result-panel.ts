import path from "node:path";
import {
  getLanguageFromPath,
  highlightCode,
  keyText,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  sliceByColumn,
} from "@earendil-works/pi-tui";
import { singleLine, preserveEnclosingBackground } from "./index.js";

/** Source identity, highlighted code, or a concise explanation inside one result frame. */
export type ResultPanelRow =
  | {
      readonly kind: "source";
      readonly label: string;
      readonly link?: string;
      readonly count?: number;
      readonly badge?: string;
    }
  | {
      readonly kind: "line";
      readonly lineNumber: number;
      readonly text: string;
      readonly ranges: readonly { readonly from: number; readonly to: number }[];
    }
  | { readonly kind: "note"; readonly text: string; readonly expandedOnly?: boolean };

/** Presentation only: these rows never grant source or edit authority. */
export interface ResultPanelModel {
  readonly summary: string;
  readonly rows: readonly ResultPanelRow[];
}

/** A shared, bounded Search-style result frame for both source and readonly records. */
export class ResultPanel implements Component {
  private cache: { width: number; lines: string[] } | undefined;
  public constructor(
    private model: ResultPanelModel,
    private theme: Theme,
    private expanded: boolean,
  ) {}
  public update(model: ResultPanelModel, theme: Theme, expanded: boolean): void {
    this.model = model;
    this.theme = theme;
    this.expanded = expanded;
    this.invalidate();
  }
  public invalidate(): void {
    this.cache = undefined;
  }
  public render(width: number): string[] {
    if (this.cache?.width === width) return [...this.cache.lines];
    if (width < 4) return [truncateToWidth(singleLine(this.model.summary), Math.max(1, width))];
    const inner = width - 2;
    const rows = this.model.rows.filter(
      (row) => row.kind !== "note" || !row.expandedOnly || this.expanded,
    );
    const gutter = Math.max(
      3,
      ...rows.map((row) => (row.kind === "line" ? String(row.lineNumber).length : 0)),
    );
    // Bound layout work as well as the finished compact viewport.
    const selected = this.expanded ? rows : rows.slice(0, 13);
    const code = highlightSourceRows(selected, this.theme);
    let body = selected.flatMap((row) => this.renderRow(row, inner, gutter, code.get(row)));
    if (!this.expanded && (body.length > 12 || selected.length < rows.length)) {
      body = [
        ...body.slice(0, 11),
        this.frame(
          this.theme.fg("dim", `  … output truncated · ${keyText("app.tools.expand")} to expand`),
          inner,
        ),
      ];
    }
    const title = truncateToWidth(` ${singleLine(this.model.summary)} `, inner - 1, "");
    const border = (s: string) => this.theme.fg("borderMuted", s);
    const output = [
      `${border("╭─")}${this.theme.fg("accent", title)}${border(`${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}╮`)}`,
      ...body,
      border(`╰${"─".repeat(inner)}╯`),
    ].map((line) => truncateToWidth(line, width));
    this.cache = { width, lines: output };
    return [...output];
  }
  private frame(content: string, width: number, highlighted = false): string {
    const clipped = truncateToWidth(content, width);
    let body = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    if (highlighted) {
      const background = this.theme.bg("selectedBg", "").replace(/\u001B\[(?:0|49)m/gu, "");
      body = this.theme.bg("selectedBg", preserveEnclosingBackground(body, background));
    }
    const border = this.theme.fg("borderMuted", "│");
    return `${border}${body}${border}`;
  }
  private renderRow(row: ResultPanelRow, width: number, gutter: number, code?: string): string[] {
    if (row.kind === "source") {
      const badge = this.theme.fg(
        badgeColor(row.label),
        this.theme.bold(row.badge ?? fileBadge(row.label)),
      );
      const count =
        row.count === undefined ? "" : this.theme.fg("accent", this.theme.bold(String(row.count)));
      const available = Math.max(1, width - visibleWidth(badge) - visibleWidth(count) - 4);
      const safe = singleLine(row.label);
      const label =
        visibleWidth(safe) <= available
          ? safe
          : `…${sliceByColumn(safe, Math.max(0, visibleWidth(safe) - available + 1), available - 1, true)}`;
      const separator = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\"));
      const directory = label.slice(0, separator + 1);
      const basename = label.slice(separator + 1);
      let linked =
        this.theme.fg("muted", directory) + this.theme.underline(this.theme.fg("accent", basename));
      if (row.link && !/[\u0000-\u001F\u007F]/u.test(row.link))
        linked = `\u001B]8;;${row.link}\u0007${linked}\u001B]8;;\u0007`;
      const left = ` ${badge} ${linked}`;
      return [
        this.frame(
          `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(count) - 1))}${count} `,
          width,
          true,
        ),
      ];
    }
    if (row.kind === "note")
      return [this.frame(this.theme.fg("dim", `  ${singleLine(row.text).slice(0, 2048)}`), width)];
    const number = this.theme.fg("dim", String(row.lineNumber).padStart(gutter));
    const prefix = ` ${number} ${this.theme.fg("borderMuted", "│")} `;
    const available = Math.max(1, width - visibleWidth(prefix) - 1);
    const preview = previewLine(row);
    const wrapped = wrapTextWithAnsi(highlight(preview, this.theme, code), available);
    const rendered = wrapped.map((line, index) =>
      this.frame(`${index ? " ".repeat(visibleWidth(prefix)) : prefix}${line}`, width),
    );
    if (preview !== row)
      rendered.push(
        this.frame(this.theme.fg("dim", "  … line shortened · read source for full text"), width),
      );
    return rendered;
  }
}

/** One exact source-line preview; offsets are UTF-16 positions in the unstyled text. */
export interface SourcePreview {
  readonly source: string;
  readonly label: string;
  readonly link?: string;
  readonly badge?: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly ranges: readonly { readonly from: number; readonly to: number }[];
}

/** Group source lines and merge highlights without duplicating context or changing input data. */
export function sourceRows(previews: readonly SourcePreview[]): ResultPanelRow[] {
  const groups = new Map<
    string,
    {
      first: SourcePreview;
      lines: Map<number, { text: string; ranges: { from: number; to: number }[] }>;
    }
  >();
  for (const preview of previews) {
    let group = groups.get(preview.source);
    if (!group) {
      group = { first: preview, lines: new Map() };
      groups.set(preview.source, group);
    }
    const previous = group.lines.get(preview.lineNumber);
    if (previous) previous.ranges.push(...preview.ranges);
    else group.lines.set(preview.lineNumber, { text: preview.text, ranges: [...preview.ranges] });
  }
  return [...groups.values()].flatMap(({ first, lines }): ResultPanelRow[] => [
    {
      kind: "source",
      label: first.label,
      ...(first.link === undefined ? {} : { link: first.link }),
      ...(first.badge === undefined ? {} : { badge: first.badge }),
    },
    ...[...lines.entries()]
      .sort(([a], [b]) => a - b)
      .map(([lineNumber, line]): ResultPanelRow => ({
        kind: "line",
        lineNumber,
        text: line.text,
        ranges: line.ranges,
      })),
  ]);
}

function previewLine(row: Extract<ResultPanelRow, { kind: "line" }>): typeof row {
  if (row.text.length <= 2048) return row;
  const start = Math.max(0, (row.ranges[0]?.from ?? 0) - 64);
  const end = Math.min(row.text.length, start + 256);
  const prefix = start ? "…" : "";
  return {
    ...row,
    text: `${prefix}${row.text.slice(start, end)}${end < row.text.length ? "…" : ""}`,
    ranges: row.ranges
      .filter((r) => r.from < end && r.to > start)
      .map((r) => ({
        from: Math.max(r.from, start) - start + prefix.length,
        to: Math.min(r.to, end) - start + prefix.length,
      })),
  };
}
function highlightSourceRows(
  rows: readonly ResultPanelRow[],
  theme: Theme,
): Map<ResultPanelRow, string> {
  const output = new Map<ResultPanelRow, string>();
  let language: string | undefined;
  let group: Extract<ResultPanelRow, { kind: "line" }>[] = [];
  const flush = () => {
    if (!group.length) return;
    const source = group.map((row) => safeCode(previewLine(row).text));
    const colored = language
      ? highlightCode(source.join("\n"), language)
      : source.map((text) => theme.fg("toolOutput", text));
    group.forEach((row, index) => output.set(row, colored[index] ?? source[index] ?? ""));
    group = [];
  };
  for (const row of rows) {
    if (row.kind === "source") {
      flush();
      language =
        row.badge === "WEB" || row.badge === "SH" ? undefined : getLanguageFromPath(row.label);
    } else if (row.kind === "line") {
      if (group.at(-1)?.lineNumber !== row.lineNumber - 1) flush();
      group.push(row);
    } else flush();
  }
  flush();
  return output;
}

function highlight(
  row: Extract<ResultPanelRow, { kind: "line" }>,
  theme: Theme,
  code?: string,
): string {
  const styled = code ?? theme.fg("toolOutput", safeCode(row.text));
  if (!row.ranges.length) return styled;
  const fragment = (from: number, to: number) =>
    sliceByColumn(
      styled,
      visibleWidth(safeCode(row.text.slice(0, from))),
      visibleWidth(safeCode(row.text.slice(from, to))),
      true,
    );
  const background = theme.bg("selectedBg", "").replace(/\u001B\[(?:0|49)m/gu, "");
  let result = "";
  let offset = 0;
  for (const range of [...row.ranges].sort((a, b) => a.from - b.from)) {
    const from = Math.max(offset, Math.min(row.text.length, range.from));
    const to = Math.max(from, Math.min(row.text.length, range.to));
    result += fragment(offset, from);
    if (to > from)
      result += theme.bg(
        "selectedBg",
        preserveEnclosingBackground(theme.bold(fragment(from, to)), background),
      );
    offset = to;
  }
  return result + fragment(offset, row.text.length);
}
function safeCode(text: string): string {
  return singleLine(text.replaceAll("\t", "    "));
}
function fileBadge(label: string): string {
  return (
    (
      {
        ".ts": "TS",
        ".tsx": "TX",
        ".js": "JS",
        ".jsx": "JX",
        ".json": "{}",
        ".md": "MD",
        ".py": "PY",
        ".rs": "RS",
        ".go": "GO",
        ".css": "CS",
        ".html": "<>",
      } as Record<string, string>
    )[path.extname(label).toLowerCase()] ?? "◇"
  );
}
function badgeColor(label: string): ThemeColor {
  return /\.(?:js|jsx|json)$/iu.test(label) ? "warning" : "accent";
}
