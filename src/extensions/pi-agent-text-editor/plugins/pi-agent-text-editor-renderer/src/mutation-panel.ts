import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  preserveEnclosingBackground,
  renderToolCallDetails,
  type ToolCallHeaderDetail,
} from "pi-agent-tool-ui";

import { createDiffModel, type DiffModel, type DiffRow } from "./diff-model.js";
import { type DiffPanelResource, renderDiffPanel } from "./diff-renderer.js";

import type { MutationRenderResource } from "./render-resource.js";

type ToolBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export class MutationPanel implements Component {
  private resources: readonly MutationRenderResource[] = [];
  private diffPanels: readonly DiffPanelResource[] = [];
  private header = "";
  private headerDetails: readonly ToolCallHeaderDetail[] = [];
  private headerExpanded = false;
  private background: ToolBackground = "toolPendingBg";
  private expanded = false;
  private resourceLabelsVisible = false;
  private cache:
    | {
        width: number;
        expanded: boolean;
        header: string;
        headerDetails: readonly ToolCallHeaderDetail[];
        headerExpanded: boolean;
        resourceLabelsVisible: boolean;
        lines: string[];
      }
    | undefined;
  private renderedRows = new Map<DiffRow, readonly string[]>();
  private renderedWidth: number | undefined;

  public constructor(
    private theme: Theme,
    private readonly ownsShell = false,
  ) {}

  public setTheme(theme: Theme): void {
    if (this.theme === theme) {
      return;
    }

    this.theme = theme;
    this.diffPanels = [];
    this.renderedRows.clear();
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
    this.renderedRows.clear();
    this.invalidate();
  }

  /** Shows each resource path inside its diff panel. */
  public setResourceLabelsVisible(visible: boolean): void {
    if (this.resourceLabelsVisible === visible) {
      return;
    }

    this.resourceLabelsVisible = visible;
    this.invalidate();
  }

  public setHeader(
    header: string,
    details: readonly ToolCallHeaderDetail[] = [],
    expanded = false,
  ): void {
    if (
      this.header === header &&
      this.headerDetails === details &&
      this.headerExpanded === expanded
    ) {
      return;
    }

    this.header = header;
    this.headerDetails = details;
    this.headerExpanded = expanded;
    this.invalidate();
  }

  public setPreviewResources(resources: readonly MutationRenderResource[]): void {
    this.resources = resources;
    this.rebuildPanels();
  }

  public setResultResources(resources: readonly MutationRenderResource[]): void {
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
      .filter(
        (resource) =>
          resource.model !== undefined || resource.beforeContent !== resource.afterContent,
      )
      .flatMap((resource) => {
        const completeModel =
          resource.model ??
          createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges);

        if (
          completeModel.added === 0 &&
          completeModel.modified === 0 &&
          completeModel.removed === 0
        ) {
          return [];
        }

        const cached = previous.find((panel) => panel.path === resource.path);

        return [
          {
            path: resource.path,
            ...(resource.link !== undefined && { link: resource.link }),
            model: completeModel,
            highlightedRows: highlightRows(resource.path, completeModel, cached?.highlightedRows),
            ...(resource.cursorOffset !== undefined && {
              cursor: cursorPosition(resource.afterContent, resource.cursorOffset),
            }),
          },
        ];
      });
    this.invalidate();
  }

  public render(width: number): string[] {
    const contentWidth = this.ownsShell ? Math.max(1, width - 2) : width;

    if (this.renderedWidth !== contentWidth) {
      this.renderedRows.clear();
      this.renderedWidth = contentWidth;
    }

    if (
      this.cache?.width === contentWidth &&
      this.cache.expanded === this.expanded &&
      this.cache.header === this.header &&
      this.cache.headerDetails === this.headerDetails &&
      this.cache.headerExpanded === this.headerExpanded &&
      this.cache.resourceLabelsVisible === this.resourceLabelsVisible
    ) {
      return this.renderShell(this.cache.lines, width);
    }

    const panels = renderPanels(this.diffPanels, (resource) =>
      renderDiffPanel(
        resource,
        contentWidth,
        this.theme,
        this.expanded,
        this.background === "toolPendingBg",
        this.renderedRows,
        this.resourceLabelsVisible,
      ),
    );
    const ellipsis = `${this.theme.getBgAnsi(this.background)}...`;
    const summary =
      this.header.length === 0 ? [] : [truncateToWidth(this.header, contentWidth, ellipsis)];
    const details = this.headerExpanded
      ? renderToolCallDetails(this.headerDetails, this.theme, contentWidth)
      : [];
    const tail = renderCounts(this.resources, this.theme);
    const lines = [...summary, ...details, ...panels, ...(tail === undefined ? [] : [tail])].map(
      (line) => preserveEnclosingBackground(line, this.theme.getBgAnsi(this.background)),
    );
    this.cache = {
      width: contentWidth,
      expanded: this.expanded,
      header: this.header,
      headerDetails: this.headerDetails,
      headerExpanded: this.headerExpanded,
      resourceLabelsVisible: this.resourceLabelsVisible,
      lines,
    };
    return this.renderShell(lines, width);
  }

  private renderShell(lines: string[], width: number): string[] {
    if (!this.ownsShell || lines.length === 0) {
      return lines;
    }

    const shell = new Box(1, 1, (text) => this.theme.bg(this.background, text));
    shell.addChild({
      render: () => lines,
      invalidate() {},
    });
    return shell.render(width);
  }
}

function renderCounts(
  resources: readonly MutationRenderResource[],
  theme: Theme,
): string | undefined {
  const totals = { added: 0, modified: 0, removed: 0 };
  let hasChanges = false;

  for (const resource of resources) {
    const model =
      resource.model ??
      createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges);
    totals.added += model.added;
    totals.modified += model.modified;
    totals.removed += model.removed;
    hasChanges ||= model.added + model.modified + model.removed > 0;
  }

  if (!hasChanges) {
    return undefined;
  }

  return `${theme.fg("success", `+${totals.added}`)} ${theme.fg("warning", `~${totals.modified}`)} ${theme.fg("error", `-${totals.removed}`)}`;
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
