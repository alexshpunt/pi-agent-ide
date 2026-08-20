import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

import { createDiffModel, type DiffModel, type DiffRow } from "./diff-model.js";
import { type DiffPanelResource, renderDiffPanel } from "./diff-renderer.js";

import type { MutationRenderResource } from "./render-resource.js";

type PanelMode = "preview" | "result";
type ToolBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export class MutationPanel implements Component {
  private resources: readonly MutationRenderResource[] = [];
  private diffPanels: readonly DiffPanelResource[] = [];
  private mode: PanelMode = "preview";
  private header = "";
  private background: ToolBackground = "toolPendingBg";
  private expanded = false;
  private cache: { width: number; expanded: boolean; header: string; lines: string[] } | undefined;

  public constructor(private theme: Theme) {}

  public setTheme(theme: Theme): void {
    if (this.theme === theme) {
      return;
    }

    this.theme = theme;
    this.diffPanels = [];
    this.rebuildPanels();
  }

  public setBackground(background: ToolBackground): void {
    if (this.background === background) {
      return;
    }

    this.background = background;
    this.invalidate();
  }

  public setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) {
      return;
    }

    this.expanded = expanded;
    this.invalidate();
  }

  public setHeader(header: string): void {
    if (this.header === header) {
      return;
    }

    this.header = header;
    this.invalidate();
  }

  public setPreviewResources(resources: readonly MutationRenderResource[]): void {
    this.mode = "preview";
    this.resources = resources;
    this.rebuildPanels();
  }

  public setResultResources(resources: readonly MutationRenderResource[]): void {
    this.mode = "result";
    this.resources = resources;
    this.rebuildPanels();
  }

  public hasResources(): boolean {
    return this.resources.length > 0;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  private rebuildPanels(): void {
    const previous = this.diffPanels;
    this.diffPanels = this.resources
      .filter((resource) => resource.beforeContent !== resource.afterContent)
      .flatMap((resource) => {
        const model =
          resource.model ??
          createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges);

        if (model.added === 0 && model.modified === 0 && model.removed === 0) {
          return [];
        }

        const cached = previous.find((panel) => panel.path === resource.path);

        return [
          {
            path: resource.path,
            ...(resource.link !== undefined && { link: resource.link }),
            model,
            highlightedRows: highlightRows(resource.path, model, cached?.highlightedRows),
            ...(resource.cursorOffset !== undefined && {
              cursor: cursorPosition(resource.afterContent, resource.cursorOffset),
            }),
          },
        ];
      });
    this.invalidate();
  }

  public render(width: number): string[] {
    if (
      this.cache?.width === width &&
      this.cache.expanded === this.expanded &&
      this.cache.header === this.header
    ) {
      return this.cache.lines;
    }

    const panels = renderPanels(this.diffPanels, (resource) =>
      renderDiffPanel(resource, width, this.theme, this.expanded, this.mode === "preview"),
    );
    const ellipsis = `${this.theme.getBgAnsi(this.background)}...`;
    const lines =
      this.header.length === 0
        ? panels
        : [truncateToWidth(this.header, width, ellipsis), ...panels];
    this.cache = { width, expanded: this.expanded, header: this.header, lines };
    return lines;
  }
}

function renderPanels<Resource>(
  resources: readonly Resource[],
  render: (resource: Resource) => string[],
): string[] {
  return resources.flatMap((resource, index) => [
    ...(index === 0 ? [] : [""]),
    ...render(resource),
  ]);
}

function highlightRows(
  path: string,
  model: DiffModel,
  cached: ReadonlyMap<DiffRow, string> | undefined,
): ReadonlyMap<DiffRow, string> {
  const highlightedRows = new Map<DiffRow, string>();
  const groups: DiffRow[][] = [];
  let group: DiffRow[] = [];

  for (const row of model.rows) {
    const cachedHighlight = cached?.get(row);

    if (cachedHighlight !== undefined) {
      if (group.length > 0) {
        groups.push(group);
        group = [];
      }

      highlightedRows.set(row, cachedHighlight);
      continue;
    }

    const line = sourceLine(row);
    const previous = group.at(-1);
    const previousLine = previous === undefined ? undefined : sourceLine(previous);
    const isStartsNewGroup =
      line === undefined ||
      (previous !== undefined &&
        (isBeforeRow(previous) !== isBeforeRow(row) ||
          previousLine === undefined ||
          line !== previousLine + 1));

    if (isStartsNewGroup && group.length > 0) {
      groups.push(group);
      group = [];
    }

    if (line !== undefined) {
      group.push(row);
    }
  }

  if (group.length > 0) {
    groups.push(group);
  }

  const language = getLanguageFromPath(path);

  for (const rows of groups) {
    const normalized = rows.map(({ text }) => text.replaceAll("\t", " ".repeat(4)));
    const highlighted = highlightCode(normalized.join("\n"), language);

    for (const [index, row] of rows.entries()) {
      highlightedRows.set(row, highlighted[index] ?? normalized[index] ?? "");
    }
  }

  return highlightedRows;
}

function sourceLine(row: DiffRow): number | undefined {
  return isBeforeRow(row) ? row.beforeLine : row.afterLine;
}

function isBeforeRow(row: DiffRow): boolean {
  return row.kind === "removed";
}

function cursorPosition(
  content: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  const prefix = content.slice(0, offset).replaceAll("\r\n", "\n");
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}
