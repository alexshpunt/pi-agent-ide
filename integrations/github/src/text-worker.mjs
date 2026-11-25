import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("GH_TEXT_SEARCH_FAILED");

// Execute user patterns off the Pi event loop; the caller owns timeout and cancellation.
const data = /** @type {import("./text-search.ts").TextSearchWork} */ (workerData);
const { source, content, pattern, flags, maximum, scope } = data;
const expression = new RegExp(pattern, flags);
/** @type {import("pi-agent-ide/api/search").SearchSelectionMatch[]} */
const matches = [];
const lines = content.split(/\r\n|\n|\r/u);
outer: for (let index = 0; index < lines.length; index++) {
  const lineText = lines[index];
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
// Node's worker MessagePort is not a cross-origin window.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(matches);
