import { requiredValue } from "../../../../utils/required-value.js";
import { TextAnchor } from "pi-agent-text";

const textSelectionAnchorBrand = Symbol.for("pi-agent-text-editor/TextSelectionAnchor");

export interface TextSelectionPosition {
  readonly lineNumber: number;
  readonly column: number;
}

export interface TextSelectionRange {
  readonly start: TextSelectionPosition;
  readonly end: TextSelectionPosition;
}

export class TextSelectionAnchor extends TextAnchor {
  readonly [textSelectionAnchorBrand] = true;
  public readonly ranges: readonly TextSelectionRange[];

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
        ranges.every(isTextSelectionRange)
      );
    } catch {
      return false;
    }
  }

  public constructor(
    value: string,
    readonly source: string,
    ranges: readonly TextSelectionRange[],
  ) {
    const copied = ranges.map((range) => ({
      start: { ...range.start },
      end: { ...range.end },
    }));
    assertSelectionRanges(copied);
    super(value, requiredValue(copied[0]).start.lineNumber);

    if (source.length === 0) {
      throw new TypeError("Text selection anchor source must be non-empty");
    }

    this.ranges = copied;
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
  return isTextSelectionPosition(candidate.start) && isTextSelectionPosition(candidate.end);
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
