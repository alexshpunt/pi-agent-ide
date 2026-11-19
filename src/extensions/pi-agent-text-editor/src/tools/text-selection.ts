import { requiredValue } from "pi-agent-invariant";
import { TextSelectionAnchor, type TextSelectionRange } from "#src/api/text-selection-anchor.ts";

import { TextMutationInputError, type TextMutationContext } from "#src/api/mutation-tool.ts";
import type { TextAnchor } from "pi-agent-text";
import { getLineEndingAt, normalizeToLF } from "#src/api/pi-edit-text.ts";

export function textSelections(
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
): ReadonlyMap<string, TextSelectionAnchor> | undefined {
  const values = [...anchors.values()];

  if (values.every((anchor) => !TextSelectionAnchor.is(anchor))) {
    return undefined;
  }

  if (values.some((anchor) => !TextSelectionAnchor.is(anchor))) {
    throw new Error(`Anchor ${field} resolved to incompatible selection types.`);
  }

  return anchors as ReadonlyMap<string, TextSelectionAnchor>;
}

export function lineAnchor(anchors: ReadonlyMap<string, TextAnchor>, field: string): TextAnchor {
  if (textSelections(anchors, field) !== undefined) {
    throw new Error(`Anchor ${field} cannot use a search selection as a line endpoint.`);
  }

  if (anchors.size !== 1) {
    throw new Error(`Anchor ${field} must resolve in one resource.`);
  }

  return requiredValue(anchors.values().next().value);
}

export interface TextAnchorSpan {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly selection: boolean;
  /**
   * For a span selected by literal text: the line ending that line breaks in text written over
   * the span take, as Pi's edit writes `newText`. Undefined writes text exactly as sent.
   */
  readonly lineEnding?: string;
}

/** The line ending text written at `offset` of a literal selection takes, as in Pi's edit. */
function literalLineEnding(
  context: TextMutationContext,
  source: string,
  anchor: TextSelectionAnchor,
  range: TextSelectionRange,
  offset: number,
): string | undefined {
  if (!anchor.literal || range.linewise === true) return undefined;
  return getLineEndingAt(context.documentFor(source).content, offset);
}

/** Text as written at a span: as sent, or with Pi's line endings for a literal selection. */
export function writtenText(text: string, lineEnding: string | undefined): string {
  if (lineEnding === undefined) return text;
  const lf = normalizeToLF(text);
  return lineEnding === "\n" ? lf : lf.replaceAll("\n", lineEnding);
}

/** Resolves one anchor to one character span, converting line anchors to whole-line spans. */
export function singleAnchorSpan(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  rangeEndpoint = false,
): TextAnchorSpan {
  if (anchors.size !== 1) {
    throw new Error(`Anchor ${field} must resolve in one resource.`);
  }

  const [source, anchor] = requiredValue(anchors.entries().next().value);
  if (TextSelectionAnchor.is(anchor)) {
    if (anchor.ranges.length !== 1) {
      throw new TextMutationInputError(
        "ANCHOR_NOT_SINGLE_MATCH",
        `Anchor ${field} must select one match for this operation.`,
      );
    }
    const selectedRange = requiredValue(
      (rangeEndpoint ? (anchor.endpointRanges ?? anchor.ranges) : anchor.ranges)[0],
    );
    const document = context.documentFor(source);
    const exactRange = selectionRange(context, source, selectedRange);
    const endLine = linewiseSelectionEndLine(selectedRange);
    if (endLine !== undefined) {
      const range = document.lineRange(selectedRange.start.lineNumber, endLine);
      return { source, ...range, selection: false };
    }
    const lineEnding = literalLineEnding(context, source, anchor, selectedRange, exactRange.from);
    return {
      source,
      ...exactRange,
      selection: true,
      ...(lineEnding !== undefined && { lineEnding }),
    };
  }

  const range = context.documentFor(source).lineRange(anchor.lineNumber, anchor.lineNumber);
  return { source, ...range, selection: false };
}

/** Whether an endpoint selects complete lines: a line anchor or a line selection. */
function selectsWholeLines(anchors: ReadonlyMap<string, TextAnchor>): boolean {
  const anchor = anchors.values().next().value;
  if (anchor === undefined) return false;
  if (!TextSelectionAnchor.is(anchor)) return true;
  return anchor.ranges.length === 1 && anchor.ranges[0]?.linewise === true;
}

/**
 * Join ordered endpoints. Two line endpoints select their complete lines; otherwise literal text
 * and :match keep character boundaries.
 */
export async function anchorSpanRange(
  context: TextMutationContext,
  starts: ReadonlyMap<string, TextAnchor>,
  ends: ReadonlyMap<string, TextAnchor> | undefined,
  startField: string,
  endField: string,
): Promise<TextAnchorSpan> {
  if (ends === undefined) return singleAnchorSpan(context, starts, startField);
  const exactEndpoints = !(selectsWholeLines(starts) && selectsWholeLines(ends));
  const start = singleAnchorSpan(context, starts, startField, exactEndpoints);
  const end = singleAnchorSpan(context, ends, endField, exactEndpoints);
  if (start.source !== end.source) {
    throw new TextMutationInputError(
      "ANCHOR_RANGE_CROSS_RESOURCE",
      `Anchors ${startField} and ${endField} must resolve in one resource.`,
    );
  }
  if (start.from > end.from) {
    throw new TextMutationInputError(
      "ANCHOR_RANGE_REVERSED",
      `Anchor ${startField} must not come after ${endField}.`,
    );
  }
  const first = requiredValue(starts.get(start.source));
  const last = requiredValue(ends.get(end.source));
  if (first.rangeRejection !== undefined) {
    const selected = context.documentFor(start.source).text({ from: start.from, to: end.to });
    const rejection = first.rangeRejection(last, selected);
    if (rejection !== undefined) {
      throw new TextMutationInputError(rejection.code, rejection.reason);
    }
  }
  await context.checkSpan?.({ source: start.source, from: start.from, to: end.to });
  return {
    source: start.source,
    from: start.from,
    to: end.to,
    selection: start.selection || end.selection,
    // Text keeps Pi's line endings only when both endpoints are literal text.
    ...(start.lineEnding !== undefined &&
      end.lineEnding !== undefined && { lineEnding: start.lineEnding }),
  };
}

/**
 * Replaces exactly the resolved extent with `text`, written as sent or, for a literal
 * selection, with Pi's line endings; empty text deletes it.
 */
export function replaceAnchorSpan(
  span: Pick<TextAnchorSpan, "from" | "to" | "lineEnding">,
  text: string,
): { readonly from: number; readonly to: number; readonly insert: string } {
  return { from: span.from, to: span.to, insert: writtenText(text, span.lineEnding) };
}

/** Deletes exactly the resolved extent, including only its own line separator. */
export function deleteAnchorSpan(span: TextAnchorSpan): {
  readonly from: number;
  readonly to: number;
  readonly insert: "";
} {
  return { from: span.from, to: span.to, insert: "" };
}

function insertionAtSpan(
  context: TextMutationContext,
  span: Pick<TextAnchorSpan, "source" | "from" | "to" | "selection">,
  insert: string,
  before: boolean,
  separation: "line" | "blank-line",
) {
  return context
    .documentFor(span.source)
    .insertAt(
      before ? span.from : span.to,
      insert,
      !span.selection || separation === "blank-line" ? separation : undefined,
    );
}

/** Inserts transferred text after the resolved selection without normalizing its bytes. */
export function insertionAfterAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string,
  separation: "line" | "blank-line" = "line",
): readonly [string, { readonly from: number; readonly to: number; readonly insert: string }] {
  const span = singleAnchorSpan(context, anchors, field);
  return [span.source, insertionAtSpan(context, span, insert, false, separation)];
}

/** Inserts transferred text before the resolved selection without normalizing its bytes. */
export function insertionBeforeAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string,
  separation: "line" | "blank-line" = "line",
): readonly [string, { readonly from: number; readonly to: number; readonly insert: string }] {
  const span = singleAnchorSpan(context, anchors, field);
  return [span.source, insertionAtSpan(context, span, insert, true, separation)];
}

function coalesceAdjacentLinewiseRanges(
  ranges: readonly TextSelectionRange[],
): readonly TextSelectionRange[] {
  const result: TextSelectionRange[] = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (
      previous?.linewise === true &&
      range.linewise === true &&
      previous.end.lineNumber === range.start.lineNumber &&
      previous.end.column === range.start.column
    ) {
      result[result.length - 1] = { ...previous, end: range.end };
    } else {
      result.push(range);
    }
  }
  return result;
}

export function selectionChanges(
  context: TextMutationContext,
  selections: ReadonlyMap<string, TextSelectionAnchor>,
  insert: string,
): ReadonlyMap<
  string,
  readonly { readonly from: number; readonly to: number; readonly insert: string }[]
> {
  return new Map(
    [...selections].map(([source, anchor]) => [
      source,
      (insert.length === 0 ? coalesceAdjacentLinewiseRanges(anchor.ranges) : anchor.ranges).map(
        (range) => {
          const span = selectionRange(context, source, range);
          const lineEnding = literalLineEnding(context, source, anchor, range, span.from);
          return replaceAnchorSpan({ ...span, lineEnding }, insert);
        },
      ),
    ]),
  );
}

/** Creates insertions before or after every selected range. */
export function insertionChanges(
  context: TextMutationContext,
  selections: ReadonlyMap<string, TextSelectionAnchor>,
  insert: string,
  before = false,
  separation: "line" | "blank-line" = "line",
): ReadonlyMap<
  string,
  readonly { readonly from: number; readonly to: number; readonly insert: string }[]
> {
  return new Map(
    [...selections].map(([source, anchor]) => [
      source,
      anchor.ranges.map((range) => {
        const span = selectionRange(context, source, range);
        const at = before ? span.from : span.to;
        return insertionAtSpan(
          context,
          { source, ...span, selection: range.linewise !== true },
          writtenText(insert, literalLineEnding(context, source, anchor, range, at)),
          before,
          separation,
        );
      }),
    ]),
  );
}

export function singleSelection(
  selections: ReadonlyMap<string, TextSelectionAnchor>,
  field: string,
): readonly [string, TextSelectionRange] {
  if (selections.size !== 1) {
    throw new Error(`Anchor ${field} must select one resource for this operation.`);
  }

  const [source, anchor] = requiredValue(selections.entries().next().value);

  if (anchor.ranges.length !== 1) {
    throw new Error(`Anchor ${field} must select one match for this operation.`);
  }

  return [source, requiredValue(anchor.ranges[0])];
}

export function selectionRange(
  context: TextMutationContext,
  source: string,
  range: TextSelectionRange,
): { readonly from: number; readonly to: number } {
  return context
    .documentFor(source)
    .range(range.start.lineNumber, range.start.column, range.end.lineNumber, range.end.column);
}

function linewiseSelectionEndLine(range: TextSelectionRange): number | undefined {
  if (range.linewise !== true) {
    return undefined;
  }
  return containingEndLine(range);
}

function containingEndLine(range: TextSelectionRange): number {
  return range.end.column === 0 && range.end.lineNumber > range.start.lineNumber
    ? range.end.lineNumber - 1
    : range.end.lineNumber;
}
