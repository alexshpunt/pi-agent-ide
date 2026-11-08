import { diffLines } from "diff";

import type { LspRange } from "./types.js";

/** Lines of one text that appear unchanged in another, as `[fromLine, toLine, count]` runs. */
type UnchangedRuns = readonly (readonly [number, number, number])[];

/** Line diffs give up after this long; a mapping that cannot be computed is a mismatch. */
const DIFF_TIMEOUT_MS = 500;

/**
 * Maps ranges from the text a language server answered for to the current text of the file.
 * Another Pi process may have edited the file meanwhile. A range moves with the lines around
 * it only when every line it covers is unchanged; a range in or across edited lines has no
 * current position, because applying it there could touch the other edit.
 */
export class LinePositionMap {
  private constructor(private readonly runs: UnchangedRuns | undefined) {}

  static between(from: string, to: string): LinePositionMap {
    if (from === to) return new LinePositionMap([[0, 0, Number.MAX_SAFE_INTEGER]]);
    const changes = diffLines(from, to, { timeout: DIFF_TIMEOUT_MS });
    if (changes === undefined) return new LinePositionMap(undefined);
    const runs: (readonly [number, number, number])[] = [];
    let fromLine = 0;
    let toLine = 0;
    for (const change of changes) {
      const count = change.count;
      if (change.added) toLine += count;
      else if (change.removed) fromLine += count;
      else {
        runs.push([fromLine, toLine, count]);
        fromLine += count;
        toLine += count;
      }
    }
    return new LinePositionMap(runs);
  }

  /** The range in the current text, or undefined when one of its lines changed. */
  mapRange(range: LspRange): LspRange | undefined {
    const run = this.runs?.find(
      ([fromLine, , count]) => range.start.line >= fromLine && range.end.line < fromLine + count,
    );
    if (run === undefined) return undefined;
    const shift = run[1] - run[0];
    return {
      start: { line: range.start.line + shift, character: range.start.character },
      end: { line: range.end.line + shift, character: range.end.character },
    };
  }
}
