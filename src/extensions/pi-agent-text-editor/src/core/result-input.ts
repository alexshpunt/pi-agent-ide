import type { ResolvedResultTargets } from "pi-agent-resource";
import { TextChangeDocument } from "./text-change-engine.js";

/** Require a verified selection of one complete file before a whole-file operation. */
export function wholeFileResultSource(result: ResolvedResultTargets): string {
  const target = result.targets[0];
  const range = target?.ranges[0];
  if (result.targets.length !== 1 || target?.ranges.length !== 1 || range === undefined)
    throw new Error("This operation requires one whole-file result target.");
  const document = new TextChangeDocument(target.expectedContent);
  const selected = document.range(
    range.start.lineNumber,
    range.start.column,
    range.end.lineNumber,
    range.end.column,
  );
  if (selected.from !== 0 || selected.to !== document.length)
    throw new Error(
      "This operation requires one whole-file result target; partial scopes are not widened.",
    );
  return target.source;
}
