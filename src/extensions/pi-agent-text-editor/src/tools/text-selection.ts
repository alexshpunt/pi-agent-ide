import { requiredValue } from "pi-agent-invariant";
import { TextSelectionAnchor, type TextSelectionRange } from "#src/api/text-selection-anchor.js";

import type { TextMutationContext } from "#src/api/mutation-tool.js";
import type { TextAnchor } from "pi-agent-text";

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
  readonly preservesTrailingLineBreak: boolean;
  /** First selected line when this span represents whole lines. */
  readonly linewiseStartLine?: number;
  /** Last selected line when this span represents whole lines. */
  readonly linewiseEndLine?: number;
}

/** Resolves one anchor to one character span, converting line anchors to whole-line spans. */
export function singleAnchorSpan(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  wholeLines = false,
): TextAnchorSpan {
  if (anchors.size !== 1) {
    throw new Error(`Anchor ${field} must resolve in one resource.`);
  }

  const [source, anchor] = requiredValue(anchors.entries().next().value);
  if (TextSelectionAnchor.is(anchor)) {
    if (anchor.ranges.length !== 1) {
      throw new Error(`Anchor ${field} must select one match for this operation.`);
    }
    const selectedRange = requiredValue(anchor.ranges[0]);
    const document = context.documentFor(source);
    const exactRange = selectionRange(context, source, selectedRange);
    const endLine = wholeLines
      ? containingEndLine(selectedRange)
      : linewiseSelectionEndLine(selectedRange);
    if (endLine !== undefined) {
      const range = document.lineRange(selectedRange.start.lineNumber, endLine);
      return {
        source,
        ...range,
        selection: false,
        preservesTrailingLineBreak: true,
        linewiseStartLine: selectedRange.start.lineNumber,
        linewiseEndLine: endLine,
      };
    }
    return { source, ...exactRange, selection: true, preservesTrailingLineBreak: false };
  }

  const range = context.documentFor(source).lineRange(anchor.lineNumber, anchor.lineNumber);
  return {
    source,
    ...range,
    selection: false,
    preservesTrailingLineBreak: true,
    linewiseStartLine: anchor.lineNumber,
    linewiseEndLine: anchor.lineNumber,
  };
}

/** A single anchor keeps its own extent; two ordered anchors select inclusive whole lines. */
export function anchorSpanRange(
  context: TextMutationContext,
  starts: ReadonlyMap<string, TextAnchor>,
  ends: ReadonlyMap<string, TextAnchor> | undefined,
  startField: string,
  endField: string,
): TextAnchorSpan {
  const start = singleAnchorSpan(context, starts, startField);
  const end = ends === undefined ? start : singleAnchorSpan(context, ends, endField);
  if (start.source !== end.source) {
    throw new Error(`Anchors ${startField} and ${endField} must resolve in one resource.`);
  }
  if (start.from > end.from) {
    throw new Error(`Anchor ${startField} must not come after ${endField}.`);
  }
  if (ends === undefined) return start;
  const first = singleAnchorSpan(context, starts, startField, true);
  const last = singleAnchorSpan(context, ends, endField, true);
  return {
    source: first.source,
    from: first.from,
    to: last.to,
    selection: false,
    preservesTrailingLineBreak: true,
  };
}

/** Converts inserted line endings to the target document's style. */
export function targetText(context: TextMutationContext, source: string, text: string): string {
  const separator = context.documentFor(source).content.includes("\r\n") ? "\r\n" : "\n";
  return text.replace(/\r\n|\r|\n/gu, separator);
}

/** Empty text deletes the selection; nonempty text preserves a line endpoint's separator. */
export function replaceAnchorSpan(
  context: TextMutationContext,
  span: TextAnchorSpan,
  text: string,
): { readonly from: number; readonly to: number; readonly insert: string } {
  if (text === "") return deleteAnchorSpan(context, span);
  const document = context.documentFor(span.source);
  let insert = targetText(context, span.source, text);
  const selected = document.text(span);
  if (span.preservesTrailingLineBreak && !/(?:\r\n|\r|\n)$/u.test(insert)) {
    const ending = /(?:\r\n|\r|\n)$/u.exec(selected)?.[0];
    if (ending !== undefined) {
      insert += ending;
    }
  }
  return { from: span.from, to: span.to, insert };
}

/** Creates a deletion while keeping whole-line deletion behavior at EOF. */
export function deleteAnchorSpan(
  context: TextMutationContext,
  span: TextAnchorSpan,
): { readonly from: number; readonly to: number; readonly insert: "" } {
  const content = context.documentFor(span.source).content;
  if (
    !span.selection &&
    span.to === content.length &&
    span.from > 0 &&
    !/(?:\r\n|\r|\n)$/u.test(content)
  ) {
    const prefix = content.slice(0, span.from);
    const match = /(?:\r\n|\r|\n)$/u.exec(prefix);
    if (match !== null) {
      return { from: span.from - match[0].length, to: span.to, insert: "" };
    }
  }
  return { from: span.from, to: span.to, insert: "" };
}

/** Inserts after the last containing line of one resolved anchor. */
export function insertionAfterAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string,
): readonly [string, { readonly from: number; readonly to: number; readonly insert: string }] {
  const span = singleAnchorSpan(context, anchors, field, true);
  const normalizedInsert = targetText(context, span.source, insert);

  const lineNumber = span.linewiseEndLine ?? lineAnchor(anchors, field).lineNumber;
  return [
    span.source,
    context.documentFor(span.source).insertAfterLine(lineNumber, normalizedInsert),
  ];
}

/** Inserts before the first containing line of one resolved anchor. */
export function insertionBeforeAnchor(
  context: TextMutationContext,
  anchors: ReadonlyMap<string, TextAnchor>,
  field: string,
  insert: string,
): readonly [string, { readonly from: number; readonly to: number; readonly insert: string }] {
  const span = singleAnchorSpan(context, anchors, field, true);
  const normalizedInsert = targetText(context, span.source, insert);

  const lineNumber = span.linewiseStartLine ?? lineAnchor(anchors, field).lineNumber;
  return [
    span.source,
    context.documentFor(span.source).insertBeforeLine(lineNumber, normalizedInsert),
  ];
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
          return replaceAnchorSpan(
            context,
            {
              source,
              ...span,
              selection: range.linewise !== true,
              preservesTrailingLineBreak: range.linewise === true,
            },
            insert,
          );
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
): ReadonlyMap<
  string,
  readonly { readonly from: number; readonly to: number; readonly insert: string }[]
> {
  return new Map(
    [...selections].map(([source, anchor]) => [
      source,
      [
        ...new Set(
          anchor.ranges.map((range) => {
            selectionRange(context, source, range);
            return before ? range.start.lineNumber : containingEndLine(range);
          }),
        ),
      ].map((line) => {
        const document = context.documentFor(source);
        const normalizedInsert = targetText(context, source, insert);
        return before
          ? document.insertBeforeLine(line, normalizedInsert)
          : document.insertAfterLine(line, normalizedInsert);
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
