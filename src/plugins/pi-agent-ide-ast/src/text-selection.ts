import type { ResolvedResultTargets } from "pi-agent-resource";
import {
  publicRange,
  retainRegion,
  SelectionError,
  type SelectedRegion,
} from "./selection-region.js";
import { SourceText } from "./source-text.js";
import type { TextSelectOperation } from "./select-schema.js";

interface Interval {
  readonly from: number;
  readonly to: number;
}

/** Derive source-backed text boundaries from independently retained input regions. */
export function selectTextRegions(
  input: ResolvedResultTargets,
  operation: TextSelectOperation,
  signal?: AbortSignal,
): { readonly regions: readonly SelectedRegion[]; readonly missingInputs: number } {
  signal?.throwIfAborted();
  const absolute = operation.kind === "range" || operation.kind === "lines";
  if (absolute && new Set(input.targets.map((target) => target.source)).size > 1)
    throw new SelectionError("MULTIPLE_SOURCES", "Absolute text bounds require one source.");
  const selected = new Map<string, SelectedRegion>();
  let missingInputs = 0;
  for (const target of input.targets) {
    signal?.throwIfAborted();
    const source = new SourceText(target.expectedContent);
    const requested = absolute ? absoluteInterval(source, operation) : undefined;
    let contained = false;
    for (const seed of target.ranges) {
      signal?.throwIfAborted();
      const from = source.offset(seed.start);
      const to = source.offset(seed.end);
      source.range(from, to);
      const intervals = requested
        ? requested.from >= from && requested.to <= to
          ? [requested]
          : []
        : transform(source, { from, to }, operation, signal);
      if (!intervals.length) missingInputs++;
      else contained = true;
      for (const interval of intervals) {
        signal?.throwIfAborted();
        const range = source.range(interval.from, interval.to);
        const expanded = interval.from < from || interval.to > to;
        if (
          expanded &&
          operation.kind !== "linesOf" &&
          !(operation.kind === "between" && operation.extent === "lines")
        )
          throw new SelectionError("OUTSIDE_SCOPE", "Text selection exceeds its input scope.");
        retainRegion(selected, {
          target,
          range,
          text: source.content.slice(interval.from, interval.to),
          origins: [{ source: target.source, range: publicRange(seed), expanded }],
        });
      }
    }
    if (requested && !contained)
      throw new SelectionError(
        "OUTSIDE_SCOPE",
        "Requested text bounds are outside every input scope.",
      );
  }
  return { regions: [...selected.values()], missingInputs };
}

function absoluteInterval(
  source: SourceText,
  operation: Extract<TextSelectOperation, { kind: "range" | "lines" }>,
): Interval {
  if (operation.kind === "range") {
    const from = source.offset({ lineNumber: operation.startLine, column: operation.startColumn });
    const to = source.offset({ lineNumber: operation.endLine, column: operation.endColumn });
    source.range(from, to);
    return { from, to };
  }
  const first = source.lines[operation.first - 1];
  const last = source.lines[operation.last - 1];
  if (
    !Number.isSafeInteger(operation.first) ||
    !Number.isSafeInteger(operation.last) ||
    !first ||
    !last ||
    operation.last < operation.first
  )
    throw new SelectionError(
      "INVALID_RANGE",
      "Line bounds are outside the retained snapshot or reversed.",
    );
  return { from: first.start, to: last.end };
}

function transform(
  source: SourceText,
  seed: Interval,
  operation: TextSelectOperation,
  signal?: AbortSignal,
): readonly Interval[] {
  const text = source.content.slice(seed.from, seed.to);
  switch (operation.kind) {
    case "between": {
      nonEmpty(operation.start);
      nonEmpty(operation.end);
      const ranges: Interval[] = [];
      let cursor = 0;
      while (cursor <= text.length) {
        signal?.throwIfAborted();
        const left = text.indexOf(operation.start, cursor);
        if (left < 0) break;
        const right = text.indexOf(operation.end, left + operation.start.length);
        if (right < 0)
          throw new SelectionError(
            "UNMATCHED_MARKER",
            "Opening marker has no following closing marker in its input scope.",
          );
        const markerStart = seed.from + left;
        const markerEnd = seed.from + right + operation.end.length;
        // Even an omitted marker must not cut a source character or line-ending pair.
        source.boundary(markerStart);
        source.boundary(markerStart + operation.start.length);
        source.boundary(seed.from + right);
        source.boundary(markerEnd);
        ranges.push(
          operation.extent === "lines"
            ? source.fullLines(markerStart, markerEnd)
            : {
                from:
                  operation.extent === "inside"
                    ? markerStart + operation.start.length
                    : markerStart,
                to: operation.extent === "inside" ? seed.from + right : markerEnd,
              },
        );
        cursor = right + operation.end.length;
      }
      return ranges;
    }
    case "sliceText": {
      const to = operation.to ?? text.length;
      orderedBounds(operation.from, to, text.length);
      return [{ from: seed.from + operation.from, to: seed.from + to }];
    }
    case "trim": {
      if (!text.trim().length) return [{ from: seed.to, to: seed.to }];
      const from = operation.side === "end" ? 0 : text.length - text.trimStart().length;
      const to = operation.side === "start" ? text.length : text.trimEnd().length;
      return [{ from: seed.from + from, to: seed.from + to }];
    }
    case "split": {
      nonEmpty(operation.delimiter);
      const ranges: Interval[] = [];
      let cursor = 0;
      while (cursor <= text.length) {
        signal?.throwIfAborted();
        const separator = text.indexOf(operation.delimiter, cursor);
        ranges.push({
          from: seed.from + cursor,
          to: separator < 0 ? seed.to : seed.from + separator,
        });
        if (separator < 0) break;
        cursor = separator + operation.delimiter.length;
      }
      return ranges;
    }
    case "linesOf": {
      return [source.fullLines(seed.from, seed.to)];
    }
    case "position": {
      const point = operation.edge === "before" ? seed.from : seed.to;
      return [{ from: point, to: point }];
    }
    case "columns": {
      const ranges: Interval[] = [];
      const first = source.lineIndex(seed.from);
      const last = source.lineIndex(seed.to > seed.from ? seed.to - 1 : seed.from);
      for (let index = first; index <= last; index++) {
        signal?.throwIfAborted();
        const line = source.lines[index];
        if (!line) throw new SelectionError("INVALID_RANGE", "Source line bounds are unavailable.");
        orderedBounds(operation.from, operation.to, line.length);
        const range = { from: line.start + operation.from, to: line.start + operation.to };
        if (range.from < seed.from || range.to > seed.to)
          throw new SelectionError("OUTSIDE_SCOPE", "Requested columns exceed their input scope.");
        ranges.push(range);
      }
      return ranges;
    }
    case "range":
    case "lines": {
      throw new SelectionError("INVALID_RANGE", "Absolute bounds must resolve against one source.");
    }
  }
}

function nonEmpty(marker: string): void {
  if (!marker.length)
    throw new SelectionError("INVALID_MARKER", "Use a non-empty literal marker or delimiter.");
}

function orderedBounds(from: number, to: number, length: number): void {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > length
  )
    throw new SelectionError("INVALID_RANGE", "Text bounds are outside their region or reversed.");
}
