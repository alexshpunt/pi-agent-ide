import { requiredValue } from "pi-agent-invariant";
import {
  createDiffModel,
  DIFF_CONTEXT_LINES,
  type DiffModel,
  type DiffRow,
  type DiffTextRange,
} from "./diff-model.js";

import type { MutationRenderResource } from "./render-resource.js";
import type {
  TextMutationPreviewRange,
  TextMutationPreviewResource,
} from "pi-agent-text-editor/api/mutation-preview";

export function projectTypingResources(
  resources: readonly TextMutationPreviewResource[],
  generatedText: string,
  visibleGeneratedText = generatedText,
): readonly MutationRenderResource[] {
  return resources.map((resource) =>
    projectTypingResource(resource, generatedText, visibleGeneratedText),
  );
}

export function preserveCompletedTypingRows(
  previousResources: readonly MutationRenderResource[],
  nextResources: readonly MutationRenderResource[],
): readonly MutationRenderResource[] {
  if (previousResources.length !== nextResources.length) {
    return nextResources;
  }

  return nextResources.map((next, resourceIndex) => {
    const previous = previousResources[resourceIndex];
    if (
      previous?.path !== next.path ||
      !samePreviewTarget(previous, next) ||
      previous.model === undefined ||
      next.model === undefined
    ) {
      return next;
    }

    const rows = [...next.model.rows];
    let nextRowIndex = 0;
    let preserved = false;
    for (const completed of previous.model.rows.slice(0, previous.model.focusRow)) {
      const matchingIndex = rows.findIndex(
        (candidate, index) =>
          index >= nextRowIndex &&
          candidate.afterLine === completed.afterLine &&
          candidate.text === completed.text,
      );
      if (matchingIndex === -1) {
        continue;
      }

      rows[matchingIndex] = completed;
      nextRowIndex = matchingIndex + 1;
      preserved = true;
    }

    if (!preserved) {
      return next;
    }

    return {
      ...next,
      model: {
        ...next.model,
        rows,
        added: rows.filter(({ kind }) => kind === "added").length,
        modified: rows.filter(({ kind }) => kind === "modified").length,
        removed: next.model.removed,
      },
    };
  });
}

function sameRanges(
  left: readonly { readonly from: number; readonly to: number }[] | undefined,
  right: readonly { readonly from: number; readonly to: number }[] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined || left.length !== right.length) {
    return false;
  }
  return left.every((range, index) => {
    const candidate = requiredValue(right[index]);
    return range.from === candidate.from && range.to === candidate.to;
  });
}

function samePreviewTarget(left: MutationRenderResource, right: MutationRenderResource): boolean {
  const leftBeforeRanges = left.typingIdentity?.beforeRanges ?? left.beforeRanges;
  const rightBeforeRanges = right.typingIdentity?.beforeRanges ?? right.beforeRanges;
  const leftRanges = left.typingIdentity?.ranges ?? left.ranges;
  const rightRanges = right.typingIdentity?.ranges ?? right.ranges;
  if (
    left.beforeContent !== right.beforeContent ||
    !sameRanges(leftBeforeRanges, rightBeforeRanges) ||
    leftRanges.length !== 1 ||
    rightRanges.length !== 1
  ) {
    return false;
  }

  const leftRange = requiredValue(leftRanges[0]);
  const rightRange = requiredValue(rightRanges[0]);
  return (
    leftRange.from === rightRange.from &&
    leftRange.to <= rightRange.to &&
    left.afterContent.slice(0, leftRange.to) === right.afterContent.slice(0, leftRange.to) &&
    left.afterContent.slice(leftRange.to) === right.afterContent.slice(rightRange.to)
  );
}
export function advanceTypingProjectionResources(
  resources: readonly TextMutationPreviewResource[],
  generatedText: string,
  previousResources: readonly MutationRenderResource[],
  previousVisibleText: string,
  visibleText: string,
): readonly MutationRenderResource[] | undefined {
  if (
    resources.length !== previousResources.length ||
    resources.length !== 1 ||
    !visibleText.startsWith(previousVisibleText) ||
    !generatedText.startsWith(visibleText)
  ) {
    return undefined;
  }

  const appended = visibleText.slice(previousVisibleText.length);
  if (appended.length === 0) {
    return undefined;
  }

  const advanced: MutationRenderResource[] = [];
  for (const [index, resource] of resources.entries()) {
    const previous = previousResources[index];
    const next =
      previous === undefined
        ? undefined
        : advanceTypingProjectionResource(
            resource,
            generatedText,
            previousVisibleText,
            visibleText,
            appended,
            previous,
          );

    if (next === undefined) {
      return undefined;
    }

    advanced.push(next);
  }

  return advanced;
}

function advanceTypingProjectionResource(
  resource: TextMutationPreviewResource,
  generatedText: string,
  previousVisibleText: string,
  visibleText: string,
  appended: string,
  previous: MutationRenderResource,
): MutationRenderResource | undefined {
  const range = resource.ranges.length === 1 ? resource.ranges[0] : undefined;
  const beforeRange = resource.beforeRanges?.length === 1 ? resource.beforeRanges[0] : undefined;
  const model = previous.model;

  if (
    range === undefined ||
    model === undefined ||
    previous.path !== resource.path ||
    previous.beforeContent !== resource.beforeContent
  ) {
    return undefined;
  }

  const isFullFile = beforeRange !== undefined && isFullFileTyping(resource, beforeRange, range);

  const generatedEnd = Math.min(range.from + generatedText.length, range.to);
  const cursorOffset = Math.min(range.from + visibleText.length, generatedEnd);

  if (isFullFile) {
    return advanceFullFileTypingResource(
      resource,
      previousVisibleText,
      visibleText,
      appended,
      previous,
    );
  }
  const cursorLine = lineAtOffset(resource.afterContent, cursorOffset);
  const rowIndex = model.rows.findLastIndex(
    (row) => row.afterLine === cursorLine && row.kind !== "removed",
  );
  const row = model.rows[rowIndex];

  if (row === undefined || row.kind === "omitted") {
    return undefined;
  }

  const expectedText = resource.afterContent.slice(
    lineStart(resource.afterContent, cursorOffset),
    cursorOffset,
  );

  if (`${row.text}${appended}` !== expectedText) {
    return undefined;
  }

  if (/\s/u.test(appended) || row.text.trimEnd() !== row.text) {
    return undefined;
  }

  const rows = [...model.rows];
  const kind = row.beforeLine === undefined ? "added" : "modified";
  rows[rowIndex] = {
    ...row,
    kind,
    text: expectedText,
    changed: true,
    addedRanges: appendedRange(row.addedRanges, row.text.length, expectedText.length),
  };

  return {
    ...resource,
    cursorOffset,
    model: {
      ...model,
      rows,
      added: model.added + (kind === "added" ? 1 : 0) - (row.kind === "added" ? 1 : 0),
      modified: model.modified + (kind === "modified" ? 1 : 0) - (row.kind === "modified" ? 1 : 0),
      focusRow: rowIndex,
    },
  };
}

function advanceFullFileTypingResource(
  resource: TextMutationPreviewResource,
  previousVisibleText: string,
  visibleText: string,
  appended: string,
  previous: MutationRenderResource,
): MutationRenderResource | undefined {
  const model = previous.model;
  const range = resource.ranges.length === 1 ? resource.ranges[0] : undefined;
  const beforeRange = resource.beforeRanges?.length === 1 ? resource.beforeRanges[0] : undefined;

  if (
    model === undefined ||
    range === undefined ||
    beforeRange === undefined ||
    previous.path !== resource.path ||
    previous.beforeContent !== resource.beforeContent ||
    !isFullFileTyping(resource, beforeRange, range)
  ) {
    return undefined;
  }

  const cursorOffset = Math.min(range.from + visibleText.length, range.to);
  const beforeLines = previous.beforeLines ?? fullFileLines(resource.beforeContent);
  const rows = [...model.rows];
  let added = model.added;
  let modified = model.modified;
  const isAfterNewline = previousVisibleText.endsWith("\n");
  const active = rows.at(-1);
  const suffix = [...fullFileLines(isAfterNewline ? appended : `${active?.text ?? ""}${appended}`)];

  if (active !== undefined && suffix.length > 0) {
    const next = createTypingLine(
      beforeLines,
      requiredValue(suffix[0]),
      rows.length - 1,
      visibleText.endsWith("\n") && suffix.length === 1 && requiredValue(suffix[0]).length === 0,
    );
    if (active.text !== next.text || active.kind !== next.kind) {
      added += (next.kind === "added" ? 1 : 0) - (active.kind === "added" ? 1 : 0);
      modified += (next.kind === "modified" ? 1 : 0) - (active.kind === "modified" ? 1 : 0);
      rows[rows.length - 1] = next;
    }
    suffix.shift();
  }

  for (const [offset, text] of suffix.entries()) {
    const row = createTypingLine(
      beforeLines,
      text,
      rows.length,
      offset === suffix.length - 1 && visibleText.endsWith("\n"),
    );
    rows.push(row);
    modified += row.kind === "modified" ? 1 : 0;
    added += row.kind === "added" ? 1 : 0;
  }

  if (rows.length < model.rows.length) {
    return undefined;
  }

  const cursorLine = (active?.afterLine ?? 1) + countNewlines(appended);
  return {
    ...resource,
    beforeLines,
    cursorOffset,
    model: {
      ...model,
      rows,
      modified,
      added,
      focusRow: typingFocusRow(rows, cursorLine),
    },
  };
}

function createTypingLine(
  beforeLines: readonly string[],
  text: string,
  index: number,
  isTrailingCursorRow = false,
): DiffRow {
  const beforeText = beforeLines[index];
  if (isTrailingCursorRow || beforeText?.trim() === text.trim()) {
    return {
      kind: "context",
      text,
      ...(beforeText !== undefined && { beforeLine: index + 1 }),
      afterLine: index + 1,
      changed: false,
    };
  }

  return {
    kind: beforeText === undefined ? "added" : "modified",
    text,
    ...(beforeText !== undefined && { beforeLine: index + 1 }),
    afterLine: index + 1,
    changed: true,
    addedRanges: typingTextRanges(text),
  };
}

function appendedRange(
  ranges: readonly DiffTextRange[] | undefined,
  from: number,
  to: number,
): readonly DiffTextRange[] {
  const previous = ranges?.at(-1);

  if (previous?.to === from) {
    return [...(ranges?.slice(0, -1) ?? []), { from: previous.from, to }];
  }

  return [...(ranges ?? []), { from, to }];
}

export function extendTypingPreviewResources(
  resources: readonly TextMutationPreviewResource[],
  previousText: string,
  nextText: string,
): readonly TextMutationPreviewResource[] | undefined {
  if (!nextText.startsWith(previousText)) {
    return undefined;
  }

  if (nextText === previousText) {
    return resources;
  }

  const appended = nextText.slice(previousText.length);
  const extended: TextMutationPreviewResource[] = [];

  for (const resource of resources) {
    const range = resource.ranges.length === 1 ? resource.ranges[0] : undefined;
    const generatedEnd = range === undefined ? -1 : range.from + previousText.length;

    if (
      range === undefined ||
      generatedEnd > range.to ||
      resource.afterContent.slice(range.from, generatedEnd) !== previousText
    ) {
      return undefined;
    }

    extended.push({
      ...resource,
      afterContent:
        resource.afterContent.slice(0, generatedEnd) +
        appended +
        resource.afterContent.slice(generatedEnd),
      ranges: [{ from: range.from, to: range.to + appended.length }],
    });
  }

  return extended;
}

function projectTypingResource(
  resource: TextMutationPreviewResource,
  generatedText: string,
  visibleGeneratedText: string,
): MutationRenderResource {
  const beforeRanges = resource.beforeRanges;

  if (beforeRanges?.length !== 1 || resource.ranges.length !== 1) {
    return resource;
  }

  const beforeRange = requiredValue(beforeRanges[0]);
  const afterRange = requiredValue(resource.ranges[0]);
  const generatedEnd = Math.min(afterRange.from + generatedText.length, afterRange.to);
  const cursorOffset = Math.min(afterRange.from + visibleGeneratedText.length, generatedEnd);

  const beforeLines = isFullFileTyping(resource, beforeRange, afterRange)
    ? fullFileLines(resource.beforeContent)
    : undefined;

  return {
    ...resource,
    ...(beforeLines !== undefined && { beforeLines }),
    cursorOffset,
    model: createTypingModel(resource, beforeRange, afterRange, generatedEnd, cursorOffset),
  };
}

function createTypingModel(
  resource: TextMutationPreviewResource,
  beforeRange: TextMutationPreviewRange,
  afterRange: TextMutationPreviewRange,
  generatedEnd: number,
  cursorOffset: number,
): DiffModel {
  const visibleReplacement = isFullFileTyping(resource, beforeRange, afterRange)
    ? resource.afterContent.slice(afterRange.from, cursorOffset)
    : resource.afterContent.slice(afterRange.from, cursorOffset) +
      resource.afterContent.slice(generatedEnd, afterRange.to);

  if (isFullFileTyping(resource, beforeRange, afterRange)) {
    return createFullFileTypingModel(resource.beforeContent, visibleReplacement, cursorOffset);
  }

  const windowFrom = contextStart(resource.beforeContent, beforeRange.from);
  const windowTo = contextEnd(resource.beforeContent, beforeRange.to);
  const beforeWindow = resource.beforeContent.slice(windowFrom, windowTo);
  const afterWindow =
    resource.beforeContent.slice(windowFrom, beforeRange.from) +
    visibleReplacement +
    resource.beforeContent.slice(beforeRange.to, windowTo);
  const lineOffset = lineAtOffset(resource.beforeContent, windowFrom) - 1;
  const cursorLine = lineAtOffset(resource.afterContent, cursorOffset);
  const modelOptions = {
    beforeLineOffset: lineOffset,
    afterLineOffset: lineOffset,
    project: false,
    focusAfterLine: cursorLine,
  } as const;
  const rows = createDiffModel(beforeWindow, afterWindow, [], modelOptions).rows.flatMap(
    projectTypingRow,
  );
  const focusRow = typingFocusRow(rows, cursorLine);
  const finalAfterWindow =
    resource.beforeContent.slice(windowFrom, beforeRange.from) +
    resource.afterContent.slice(afterRange.from, afterRange.to) +
    resource.beforeContent.slice(beforeRange.to, windowTo);
  const finalRows = createDiffModel(beforeWindow, finalAfterWindow, [], modelOptions).rows.flatMap(
    projectTypingRow,
  );
  const canonicalRows = rows.map((row, index) =>
    index >= focusRow
      ? row
      : (finalRows.find(
          (finalRow) => finalRow.afterLine === row.afterLine && finalRow.text === row.text,
        ) ?? row),
  );

  return {
    rows: canonicalRows,
    added: canonicalRows.filter(({ kind }) => kind === "added").length,
    modified: canonicalRows.filter(({ kind }) => kind === "modified").length,
    removed: 0,
    focusRow,
  };
}

function isFullFileTyping(
  resource: TextMutationPreviewResource,
  beforeRange: TextMutationPreviewRange,
  afterRange: TextMutationPreviewRange,
): boolean {
  return (
    beforeRange.from === 0 &&
    beforeRange.to === resource.beforeContent.length &&
    afterRange.from === 0 &&
    afterRange.to === resource.afterContent.length
  );
}

function createFullFileTypingModel(
  beforeContent: string,
  visibleContent: string,
  cursorOffset: number,
): DiffModel {
  const beforeLines = fullFileLines(beforeContent);
  const visibleLines = fullFileLines(visibleContent);
  const cursorLine = lineAtOffset(visibleContent, cursorOffset);
  const rows: DiffRow[] = visibleLines.map((text, index) => {
    const line = index + 1;
    const beforeText = beforeLines[index];
    const isTrailingCursorRow =
      line === cursorLine &&
      index === visibleLines.length - 1 &&
      text.length === 0 &&
      visibleContent.endsWith("\n");

    if (beforeText?.trim() === text.trim() || isTrailingCursorRow) {
      return {
        kind: "context",
        text,
        ...(beforeText !== undefined && { beforeLine: line }),
        afterLine: line,
        changed: false,
      };
    }

    return {
      kind: beforeText === undefined ? "added" : "modified",
      text,
      ...(beforeText !== undefined && { beforeLine: line }),
      afterLine: line,
      changed: true,
      addedRanges: typingTextRanges(text),
    };
  });

  return {
    rows,
    added: rows.filter(({ kind }) => kind === "added").length,
    modified: rows.filter(({ kind }) => kind === "modified").length,
    removed: 0,
    focusRow: typingFocusRow(rows, cursorLine),
  };
}

function fullFileLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }

  return content.replaceAll("\r\n", "\n").split("\n");
}

function projectTypingRow(row: DiffRow): readonly DiffRow[] {
  if (row.kind === "removed") {
    return [];
  }

  return row.kind === "added" ? [{ ...row, addedRanges: typingTextRanges(row.text) }] : [row];
}

function typingTextRanges(text: string): readonly DiffTextRange[] {
  const from = text.length - text.trimStart().length;
  const to = text.trimEnd().length;
  return from < to ? [{ from, to }] : [];
}

function contextStart(content: string, offset: number): number {
  let start = lineStart(content, offset);

  for (let line = 0; line < DIFF_CONTEXT_LINES && start > 0; line++) {
    start = lineStart(content, start - 1);
  }

  return start;
}

function contextEnd(content: string, offset: number): number {
  let end = offset;

  for (let line = 0; line < DIFF_CONTEXT_LINES && end < content.length; line++) {
    const lineBreak = content.indexOf("\n", end);
    end = lineBreak === -1 ? content.length : lineBreak + 1;
  }

  return end;
}

function lineStart(content: string, offset: number): number {
  return content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function countNewlines(content: string): number {
  let count = 0;

  for (const character of content) {
    if (character === "\n") {
      count++;
    }
  }

  return count;
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < Math.min(offset, content.length); index++) {
    if (content[index] === "\n") {
      line++;
    }
  }

  return line;
}

function typingFocusRow(rows: readonly DiffRow[], cursorLine: number): number {
  const row = rows.findLastIndex(
    (candidate) => candidate.afterLine !== undefined && candidate.afterLine <= cursorLine,
  );
  return row === -1 ? Math.max(0, rows.length - 1) : row;
}
