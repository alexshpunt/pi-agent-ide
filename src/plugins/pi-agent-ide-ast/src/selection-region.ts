import type { ResultRange, ResultSourceTarget } from "pi-agent-resource";
import type { SelectionItem } from "./select-schema.js";

/** A structural or text refusal is distinct from valid absence. */
export class SelectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Verified geometry and original seed associations before handles and previews are added. */
export interface SelectedRegion {
  readonly target: ResultSourceTarget;
  readonly range: ResultRange;
  readonly text: string;
  readonly origins: SelectionItem["origins"];
  readonly syntax?: SelectionItem["syntax"];
}

/** Coordinates use one-based lines and exclusive UTF-16 character ends. */
export function publicRange(range: ResultRange): SelectionItem["range"] {
  return {
    startLine: range.start.lineNumber,
    startColumn: range.start.column,
    endLine: range.end.lineNumber,
    endColumn: range.end.column,
  };
}

/** Deduplicate output geometry without losing any original input association. */
export function retainRegion(selected: Map<string, SelectedRegion>, region: SelectedRegion): void {
  const identity = JSON.stringify([region.target.source, region.range]);
  const previous = selected.get(identity);
  selected.set(
    identity,
    previous ? { ...region, origins: [...previous.origins, ...region.origins] } : region,
  );
}
