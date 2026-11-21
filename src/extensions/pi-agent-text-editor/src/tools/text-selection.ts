import { requiredValue } from "pi-agent-invariant";
import { TextSelectionAnchor, type TextSelectionRange } from "#src/api/text-selection-anchor.ts";

import {
  TextMutationInputError,
  type TextMutationChange,
  type TextMutationContext,
} from "#src/api/mutation-tool.ts";
import { selectorFields, type TextSelector } from "#src/api/text-selector-fields.ts";
import type { TextAnchor } from "pi-agent-text";
import type {
  TextChange,
  TextChangeDocument,
  TextInsertOptions,
  TextSpan,
  TextTransfer,
} from "#src/core/text-change-engine.ts";

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

/** A resolved selector: only a place in one resource. The document writes every edit there. */
export interface TextAnchorSpan extends TextSpan {
  readonly source: string;
  /** A gap bounded by two selectors, not an empty line selected for replacement. */
  readonly insertion?: "character" | "line";
}

interface RangeBoundaries {
  readonly excludeStart?: boolean;
  readonly excludeEnd?: boolean;
}

/** The span of one selected range: whole lines for a line selection, else its characters. */
export function selectionSpan(document: TextChangeDocument, range: TextSelectionRange): TextSpan {
  if (range.linewise === true)
    return document.lineSpan(range.start.lineNumber, containingEndLine(range));
  return document.charSpan(
    document.range(
      range.start.lineNumber,
      range.start.column,
      range.end.lineNumber,
      range.end.column,
    ),
  );
}

/** Resolves one anchor to one span; a line anchor selects its whole line. */
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
  const document = context.documentFor(source);
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
    // Validates the range's positions even when it selects whole lines.
    selectionRange(context, source, selectedRange);
    return { source, ...selectionSpan(document, selectedRange) };
  }

  return { source, ...document.lineSpan(anchor.lineNumber, anchor.lineNumber) };
}

/** Whether an endpoint selects complete lines: a line anchor or a line selection. */
function selectsWholeLines(anchors: ReadonlyMap<string, TextAnchor>): boolean {
  const anchor = anchors.values().next().value;
  if (anchor === undefined) return false;
  if (!TextSelectionAnchor.is(anchor)) return true;
  return anchor.ranges.length === 1 && anchor.ranges[0]?.linewise === true;
}

/** Resolve one selected span; exclude boundaries only in a paired range. */
export async function resolveTextSpan(
  context: TextMutationContext,
  selector: TextSelector,
  starts?: ReadonlyMap<string, TextAnchor>,
): Promise<TextAnchorSpan> {
  const anchors = starts ?? (await context.resolveAnchors(selector.first));
  return selector.kind === "range"
    ? resolveAnchorSpanRange(context, anchors, selector.first, selector.last, selector)
    : singleAnchorSpan(context, anchors, selector.first);
}

/** A range between adjacent markers is an insertion gap, not an empty line to overwrite. */
export function replaceSelectedSpan(
  document: TextChangeDocument,
  span: TextAnchorSpan,
  insert: string | TextTransfer,
): TextChange {
  return span.insertion !== undefined && insert !== ""
    ? document.insert(span, insert, { before: true, linewise: span.insertion === "line" })
    : document.replace(span, insert);
}

export async function transferToTextSelector(
  context: TextMutationContext,
  copied: TextTransfer,
  selector: TextSelector = { kind: "single", first: "targetAt" },
): Promise<readonly [TextAnchorSpan, TextMutationChange]> {
  const span = await resolveTextSpan(context, selector);
  const document = context.documentFor(span.source);
  const insertion = selector.kind === "insert-before" || selector.kind === "insert-after";
  const change = insertion
    ? document.insert(span, copied, { before: selector.kind === "insert-before" })
    : replaceSelectedSpan(document, span, copied);
  return [
    insertion ? { source: span.source, from: change.from, to: change.to } : span,
    { ...change, selectorFields: selectorFields(selector) },
  ];
}

/** Resolve a paired end only after the first selector has resolved to one span. */
async function resolveAnchorSpanRange(
  context: TextMutationContext,
  starts: ReadonlyMap<string, TextAnchor>,
  startField: string,
  endField: string,
  boundaries: RangeBoundaries,
): Promise<TextAnchorSpan> {
  const start = singleAnchorSpan(context, starts, startField, true);
  const minimumEndStart = excludesBoundary(boundaries) ? start.to : start.from;
  const ends = await context.resolveAnchors(endField, {
    source: start.source,
    offset: minimumEndStart,
  });
  const end = ends.get(start.source);
  let selectedEnds = ends;
  if (ends.size === 1 && TextSelectionAnchor.is(end) && end.ranges.length > 1) {
    const document = context.documentFor(start.source);
    const endpoints = end.endpointRanges ?? end.ranges;
    let nearest: { index: number; offset: number } | undefined;
    for (const [index, range] of endpoints.entries()) {
      selectionRange(context, start.source, range);
      const offset = selectionSpan(document, range).from;
      if (offset >= minimumEndStart && (nearest === undefined || offset < nearest.offset))
        nearest = { index, offset };
    }
    if (nearest === undefined) {
      throw new TextMutationInputError(
        "ANCHOR_NOT_FOUND_AFTER_START",
        `No match for ${endField} follows ${startField} in "${start.source}". Choose a later match for ${endField}.`,
      );
    }
    selectedEnds = new Map([
      [
        start.source,
        new TextSelectionAnchor(
          end.value,
          start.source,
          [requiredValue(end.ranges[nearest.index])],
          end.endpointRanges === undefined ? undefined : [requiredValue(endpoints[nearest.index])],
        ),
      ],
    ]);
  }
  return anchorSpanRange(context, starts, selectedEnds, startField, endField, boundaries);
}

/**
 * Join ordered endpoints. Two line endpoints select their complete lines. Otherwise the span keeps
 * character boundaries, and a line endpoint gives its line's content boundary.
 */
export async function anchorSpanRange(
  context: TextMutationContext,
  starts: ReadonlyMap<string, TextAnchor>,
  ends: ReadonlyMap<string, TextAnchor> | undefined,
  startField: string,
  endField: string,
  boundaries: RangeBoundaries = {},
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
  const trimsBoundary = excludesBoundary(boundaries);
  if (trimsBoundary && end.from < start.to) {
    throw new TextMutationInputError(
      "ANCHOR_RANGE_OVERLAP",
      `Anchors ${startField} and ${endField} overlap. Choose a match for ${endField} that starts after ${startField}.`,
    );
  }
  const document = context.documentFor(start.source);
  const right = end.to < start.to ? start : end;
  const span: TextSpan =
    start.lines !== undefined && end.lines !== undefined
      ? document.lineSpan(start.lines.first, Math.max(start.lines.last, end.lines.last))
      : {
          ...document.charSpan({ from: start.from, to: right.to }),
          ...(right.lines === undefined ? {} : { endLine: right.lines.last }),
        };
  const first = requiredValue(starts.get(start.source));
  const last = requiredValue(ends.get(end.source));
  if (first.rangeRejection !== undefined) {
    // Line anchors verify the lines as they were shown: with their endings.
    const selected = document.text(
      span.lines === undefined ? span : document.lineRange(span.lines.first, span.lines.last),
    );
    const rejection = first.rangeRejection(last, selected);
    if (rejection !== undefined) {
      throw new TextMutationInputError(rejection.code, rejection.reason);
    }
  }
  const selected = trimsBoundary
    ? trimRangeBoundaries(document, span, start, end, boundaries)
    : span;
  await context.checkSpan?.({ source: start.source, from: selected.from, to: selected.to });
  return { source: start.source, ...selected };
}

function excludesBoundary(boundaries: RangeBoundaries): boolean {
  return boundaries.excludeStart === true || boundaries.excludeEnd === true;
}

/** Exclude a boundary's separator only when it meets the edge of a physical line. */
function trimRangeBoundaries(
  document: TextChangeDocument,
  span: TextSpan,
  start: TextSpan,
  end: TextSpan,
  { excludeStart, excludeEnd }: RangeBoundaries,
): TextSpan & Pick<TextAnchorSpan, "insertion"> {
  let from = excludeStart === true ? start.to : span.from;
  let to = excludeEnd === true ? end.from : span.to;
  let endLine = span.lines?.last ?? span.endLine;
  if (excludeStart === true) {
    const line = document.lineNumberAt(from);
    if (
      from === document.lineContentEnd(line) &&
      (from !== document.lineContentStart(line) || start.lines?.last === line) &&
      from < document.length
    ) {
      const nextLine = document.lineRange(line, line).to;
      if (nextLine <= to) from = nextLine;
    }
  }
  if (excludeEnd === true) {
    const line = document.lineNumberAt(to);
    endLine = undefined;
    if (line > 1 && to === document.lineContentStart(line)) {
      if (excludeStart === true && from === to) return { from, to: from, insertion: "line" };
      endLine = line - 1;
      to = document.lineContentEnd(endLine);
    }
  }
  if (from === to && endLine === undefined && excludeStart === true && excludeEnd === true)
    return { from, to, insertion: "character" };
  return { ...document.charSpan({ from, to }), ...(endLine === undefined ? {} : { endLine }) };
}

/** Inserts text after the resolved anchor through the document's one write path. */
export function insertionAfterAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string | TextTransfer,
  options: TextInsertOptionsWithoutBefore = {},
): readonly [string, TextChange] {
  const span = singleAnchorSpan(context, anchors, field);
  return [span.source, context.documentFor(span.source).insert(span, insert, options)];
}

/** Inserts text before the resolved anchor through the document's one write path. */
export function insertionBeforeAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string | TextTransfer,
  options: TextInsertOptionsWithoutBefore = {},
): readonly [string, TextChange] {
  const span = singleAnchorSpan(context, anchors, field);
  return [
    span.source,
    context.documentFor(span.source).insert(span, insert, { ...options, before: true }),
  ];
}

type TextInsertOptionsWithoutBefore = Omit<TextInsertOptions, "before">;

/** Writes `insert` over every selected range; empty text deletes them. */
export function selectionChanges(
  context: TextMutationContext,
  selections: ReadonlyMap<string, TextSelectionAnchor>,
  insert: string,
): ReadonlyMap<string, readonly TextChange[]> {
  return new Map(
    [...selections].map(([source, anchor]) => {
      const document = context.documentFor(source);
      const spans = anchor.ranges.map((range) => selectionSpan(document, range));
      return [
        source,
        insert.length === 0
          ? document.deleteSpans(spans)
          : spans.map((span) => document.replace(span, insert)),
      ];
    }),
  );
}

/** Creates insertions before or after every selected range. */
export function insertionChanges(
  context: TextMutationContext,
  selections: ReadonlyMap<string, TextSelectionAnchor>,
  insert: string,
  before = false,
  separation: "line" | "blank-line" = "line",
): ReadonlyMap<string, readonly TextChange[]> {
  return new Map(
    [...selections].map(([source, anchor]) => {
      const document = context.documentFor(source);
      return [
        source,
        anchor.ranges.map((range) =>
          document.insert(selectionSpan(document, range), insert, { before, separation }),
        ),
      ];
    }),
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

function containingEndLine(range: TextSelectionRange): number {
  return range.end.column === 0 && range.end.lineNumber > range.start.lineNumber
    ? range.end.lineNumber - 1
    : range.end.lineNumber;
}
