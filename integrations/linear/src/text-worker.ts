import { parentPort, workerData } from "node:worker_threads";
import type { SearchSelectionMatch } from "pi-agent-ide/api/search";

interface Point {
  readonly lineNumber: number;
  readonly column: number;
}

export interface TextMatchRequest {
  readonly source: string;
  readonly content: string;
  readonly pattern: string;
  readonly flags: string;
  readonly maximum: number;
  readonly scope?: {
    readonly targets: readonly {
      readonly source: string;
      readonly ranges: readonly { readonly start: Point; readonly end: Point }[];
    }[];
  };
}

const port = parentPort;
if (port === null) throw new Error("Text matcher requires a worker thread");

// Execute user patterns off the Pi event loop; the caller owns timeout and cancellation.
const { source, content, pattern, flags, maximum, scope } = workerData as TextMatchRequest;
const expression = new RegExp(pattern, flags);
const matches: SearchSelectionMatch[] = [];
outer: for (const [index, lineText] of content.split(/\r\n|\n|\r/u).entries()) {
  for (const found of lineText.matchAll(expression)) {
    const match = {
      source,
      lineNumber: index + 1,
      startColumn: found.index,
      endColumn: found.index + found[0].length,
      matchedText: found[0],
      lineText,
    };
    // Apply exact single-line containment before the output cap, without loading the full SDK.
    if (
      scope &&
      !scope.targets.some(
        (target) =>
          target.source === source &&
          target.ranges.some(
            (range) =>
              (range.start.lineNumber < match.lineNumber ||
                (range.start.lineNumber === match.lineNumber &&
                  range.start.column <= match.startColumn)) &&
              (range.end.lineNumber > match.lineNumber ||
                (range.end.lineNumber === match.lineNumber && range.end.column >= match.endColumn)),
          ),
      )
    )
      continue;
    matches.push(match);
    if (matches.length >= maximum) break outer;
  }
}
port.postMessage(matches, []);
