import type { ResolvedResultTargets } from "pi-agent-resource";
import { TextChangeDocument } from "./text-change-engine.js";

const writePartialReason =
  "Write received a partial file selection. Use replace to edit that selection, or Read the whole file before deliberately replacing all its contents.";

/** Require one complete file; name Write to provide its specific recovery instructions. */
export function wholeFileResultSource(
  result: ResolvedResultTargets,
  operation?: "write" | "undo",
): string {
  const target = result.targets[0];
  const range = target?.ranges[0];
  if (result.targets.length !== 1 || target?.ranges.length !== 1 || range === undefined) {
    if (operation === "write") {
      if (result.targets.length === 0)
        throw new Error(
          "Write received no file selection. Read the intended whole file before replacing it.",
        );
      if (result.targets.length > 1)
        throw new Error(
          "Write received multiple files. Choose one file and Read its whole contents before replacing it.",
        );
      throw new Error(writePartialReason);
    }
    throw new Error("This operation requires one whole-file result target.");
  }
  const document = new TextChangeDocument(target.expectedContent);
  const selected = document.range(
    range.start.lineNumber,
    range.start.column,
    range.end.lineNumber,
    range.end.column,
  );
  if (selected.from !== 0 || selected.to !== document.length)
    throw new Error(
      operation === "write"
        ? writePartialReason
        : "This operation requires one whole-file result target; partial scopes are not widened.",
    );
  return target.source;
}
