import { requiredValue } from "pi-agent-invariant";
import { TextAnchor, type TextSelectionPosition, type TextSelectionRange } from "pi-agent-text";

export type { TextSelectionPosition, TextSelectionRange } from "pi-agent-text";

const textSelectionAnchorBrand = Symbol.for("pi-agent-text-editor/TextSelectionAnchor");

export class TextSelectionAnchor extends TextAnchor {
  readonly [textSelectionAnchorBrand] = true;
  public readonly ranges: readonly TextSelectionRange[];
  /** Unexpanded selector extents for paired range endpoints; defaults to ranges. */
  public readonly endpointRanges?: readonly TextSelectionRange[];

  public static is(value: unknown): value is TextSelectionAnchor {
    if (!TextAnchor.is(value)) {
      return false;
    }

    try {
      const candidate = asPropertyRecord(value);
      const ranges = candidate.ranges;
      return (
        candidate[textSelectionAnchorBrand] === true &&
        typeof candidate.source === "string" &&
        candidate.source.length > 0 &&
        Array.isArray(ranges) &&
        ranges.length > 0 &&
        ranges.every(isTextSelectionRange) &&
        (candidate.endpointRanges === undefined ||
          (Array.isArray(candidate.endpointRanges) &&
            candidate.endpointRanges.length === ranges.length &&
            candidate.endpointRanges.every(isTextSelectionRange)))
      );
    } catch {
      return false;
    }
  }

  public constructor(
    value: string,
    readonly source: string,
    ranges: readonly TextSelectionRange[],
    endpointRanges?: readonly TextSelectionRange[],
  ) {
    const copied = ranges.map((range) => ({
      start: { ...range.start },
      end: { ...range.end },
      ...(range.linewise === true && { linewise: true }),
    }));
    assertSelectionRanges(copied);
    super(value, requiredValue(copied[0]).start.lineNumber);

    if (source.length === 0) {
      throw new TypeError("Text selection anchor source must be non-empty");
    }

    this.ranges = copied;
    if (endpointRanges !== undefined) {
      const endpoints = endpointRanges.map((range) => ({
        start: { ...range.start },
        end: { ...range.end },
        ...(range.linewise === true && { linewise: true }),
      }));
      assertSelectionRanges(endpoints);
      if (
        endpoints.length !== copied.length ||
        endpoints.some((range, index) => {
          const outer = requiredValue(copied[index]);
          return (
            comparePositions(range.start, outer.start) < 0 ||
            comparePositions(range.end, outer.end) > 0
          );
        })
      ) {
        throw new RangeError(
          "Endpoint ranges must stay within their corresponding selection ranges",
        );
      }
      this.endpointRanges = endpoints;
    }
  }
}

function assertSelectionRanges(ranges: readonly TextSelectionRange[]): void {
  if (ranges.length === 0) {
    throw new TypeError("Text selection anchor must contain at least one range");
  }

  let previous: TextSelectionRange | undefined;

  for (const range of ranges) {
    if (!isTextSelectionRange(range) || comparePositions(range.start, range.end) > 0) {
      throw new RangeError("Text selection anchor contains an invalid range");
    }

    if (previous !== undefined && comparePositions(range.start, previous.end) < 0) {
      throw new Error("Text selection anchor ranges must be ordered and must not overlap");
    }

    previous = range;
  }
}

function isTextSelectionRange(value: unknown): value is TextSelectionRange {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TextSelectionRange>;
  return (
    isTextSelectionPosition(candidate.start) &&
    isTextSelectionPosition(candidate.end) &&
    (candidate.linewise === undefined || typeof candidate.linewise === "boolean")
  );
}

function isTextSelectionPosition(value: unknown): value is TextSelectionPosition {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TextSelectionPosition>;
  return (
    Number.isSafeInteger(candidate.lineNumber) &&
    (candidate.lineNumber ?? 0) >= 1 &&
    Number.isSafeInteger(candidate.column) &&
    (candidate.column ?? -1) >= 0
  );
}

function asPropertyRecord(value: unknown): Record<PropertyKey, unknown> {
  return value as Record<PropertyKey, unknown>;
}

function comparePositions(left: TextSelectionPosition, right: TextSelectionPosition): number {
  return left.lineNumber - right.lineNumber || left.column - right.column;
}
