import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  sourceRows,
  type ResultPanelModel,
  type ResultPanelRow,
  type SourcePreview,
} from "pi-agent-tool-ui";
import type { SelectedRegion } from "./selection-region.js";

/** Render verified snapshot context separately from agent previews and target authority. */
export function selectPresentation(
  regions: readonly SelectedRegion[],
  complete: boolean,
  missingInputs: number,
  cwd: string,
): ResultPanelModel {
  const groups = new Map<string, SelectedRegion[]>();
  for (const region of regions) {
    const group = groups.get(region.target.source);
    if (group) group.push(region);
    else groups.set(region.target.source, [region]);
  }
  const rows: ResultPanelRow[] = [];
  if (!regions.length) rows.push({ kind: "note", text: "No selections" });
  if (!complete) rows.push({ kind: "note", text: "Incomplete input; not a complete edit scope" });
  if (missingInputs)
    rows.push({ kind: "note", text: `${missingInputs} input(s) without a selection` });
  let remaining = 100;
  for (const [source, selected] of groups) {
    if (!remaining) break;
    const shown = selected.slice(0, remaining);
    remaining -= shown.length;
    const label = path.relative(cwd, source) || path.basename(source);
    const previews: SourcePreview[] = [];
    let shortened = false;
    const content = selected[0]?.target.expectedContent.split(/\r\n|\n|\r/u) ?? [];
    for (const region of shown) {
      const { start, end } = region.range;
      const point = start.lineNumber === end.lineNumber && start.column === end.column;
      const last = point ? start.lineNumber : end.lineNumber - (end.column === 0 ? 1 : 0);
      const through = Math.min(last, start.lineNumber + 19);
      shortened ||= through < last;
      for (let number = start.lineNumber; number <= through; number++) {
        const text = content[number - 1] ?? "";
        previews.push({
          source,
          label,
          link: pathToFileURL(source).href,
          lineNumber: number,
          text,
          ranges: [
            {
              from: number === start.lineNumber ? start.column : 0,
              to: number === end.lineNumber ? end.column : text.length,
            },
          ],
        });
      }
    }
    const groupRows = sourceRows(previews);
    rows.push(
      ...groupRows.map((row) => (row.kind === "source" ? { ...row, count: selected.length } : row)),
    );
    if (shortened)
      rows.push({ kind: "note", text: "… selection preview shortened · full target retained" });
    for (const region of shown) {
      if (
        region.range.start.lineNumber === region.range.end.lineNumber &&
        region.range.start.column === region.range.end.column
      )
        rows.push({
          kind: "note",
          text: `zero-width · ${region.range.start.lineNumber}:${region.range.start.column}`,
        });
      const { start, end } = region.range;
      rows.push({
        kind: "note",
        expandedOnly: true,
        text: `${region.syntax ? `${region.syntax.object}${region.syntax.part ? `/${region.syntax.part}` : ""} · ` : ""}${start.lineNumber}:${start.column}–${end.lineNumber}:${end.column} · ${region.origins.length} origin(s)${region.origins.some((o) => o.expanded) ? " · expanded" : ""}`,
      });
      for (const origin of region.origins.slice(0, 20)) {
        const r = origin.range;
        rows.push({
          kind: "note",
          expandedOnly: true,
          text: `from ${r.startLine}:${r.startColumn}–${r.endLine}:${r.endColumn}`,
        });
      }
      if (region.origins.length > 20)
        rows.push({
          kind: "note",
          expandedOnly: true,
          text: "… more origins retained in this result reference",
        });
    }
  }
  if (regions.length > 100)
    rows.push({ kind: "note", text: "… more selections · consume the complete result target" });
  return {
    summary: `${regions.length} ${regions.length === 1 ? "selection" : "selections"} in ${groups.size} ${groups.size === 1 ? "file" : "files"}${complete ? "" : " · incomplete"}`,
    rows,
  };
}
