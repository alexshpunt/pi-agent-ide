import type { DiffModel, DiffRow } from "./diff-model.js";

export const COMPACT_BODY_ROWS = 12;

export interface ViewportRow {
  readonly row?: DiffRow;
  readonly omitted?: number;

  /** Changed rows hidden by compact presentation, available when expanded. */
  readonly omittedChanged?: number;
}

export function compactViewport(model: DiffModel): readonly ViewportRow[] {
  if (model.rows.length <= COMPACT_BODY_ROWS) {
    return model.rows.map((row) => ({ row }));
  }

  const start = Math.max(0, Math.min(model.focusRow - 5, model.rows.length - COMPACT_BODY_ROWS));
  const end = start + COMPACT_BODY_ROWS;
  const selected: ViewportRow[] = model.rows.slice(start, end).map((row) => ({ row }));

  if (start > 0) {
    selected[0] = {
      omitted: start + 1,
      omittedChanged: model.rows.slice(0, start + 1).filter((row) => row.changed).length,
    };
  }

  if (end < model.rows.length) {
    selected[selected.length - 1] = {
      omitted: model.rows.length - end + 1,
      omittedChanged: model.rows.slice(end - 1).filter((row) => row.changed).length,
    };
  }

  return selected;
}

export function expandedViewport(model: DiffModel): readonly ViewportRow[] {
  return model.rows.map((row) => ({ row }));
}
