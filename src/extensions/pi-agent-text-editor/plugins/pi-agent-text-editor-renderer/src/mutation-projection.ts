import { requiredValue } from "../../../../../utils/required-value.js";
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

export function advanceTypingProjectionResources(
  resources: readonly TextMutationPreviewResource[],
  generatedText: string,
  previousResources: readonly MutationRenderResource[],
  previousVisibleText: string,
  visibleText: string,
): readonly MutationRenderResource[] | undefined {
  if (
    resources.length !== previousResources.length ||
    !visibleText.startsWith(previousVisibleText) ||
    !generatedText.startsWith(visibleText)
  ) {
    return undefined;
  }

  const appended = visibleText.slice(previousVisibleText.length);

  if (appended.length === 0 || /[\r\n]/u.test(appended)) {
    return undefined;
  }

  const advanced: MutationRenderResource[] = [];

  for (const [index, resource] of resources.entries()) {
    const previous = previousResources[index];
    const next =
      previous === undefined
        ? undefined
        : advanceTypingProjectionResource(resource, generatedText, visibleText, appended, previous);

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

  if (
    (!isFullFile && (/\s/u.test(appended) || row.text.trimEnd() !== row.text)) ||
    (isFullFile && atLineEnd(resource.afterContent, cursorOffset))
  ) {
    return undefined;
  }

  const rows = [...model.rows];
  rows[rowIndex] = {
    ...row,
    kind: "modified",
    text: expectedText,
    changed: true,
    addedRanges: isFullFile
      ? typingTextRanges(expectedText)
      : appendedRange(row.addedRanges, row.text.length, expectedText.length),
  };

  return {
    ...resource,
    cursorOffset,
    model: {
      ...model,
      rows,
      modified: model.modified + (row.kind === "context" ? 1 : 0),
      focusRow: rowIndex,
    },
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

  return {
    ...resource,
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
  const visibleReplacement =
    resource.afterContent.slice(afterRange.from, cursorOffset) +
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
  const semantic = createDiffModel(beforeWindow, afterWindow, [], {
    beforeLineOffset: lineOffset,
    afterLineOffset: lineOffset,
    project: false,
    focusAfterLine: cursorLine,
  });
  const rows = semantic.rows.flatMap(projectTypingRow);

  return {
    rows,
    added: 0,
    modified: rows.filter(({ kind }) => kind === "modified").length,
    removed: 0,
    focusRow: typingFocusRow(rows, cursorLine),
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
      kind: "modified",
      text,
      ...(beforeText !== undefined && { beforeLine: line }),
      afterLine: line,
      changed: true,
      addedRanges: typingTextRanges(text),
    };
  });

  return {
    rows,
    added: 0,
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

  if (row.kind !== "added") {
    return [row];
  }

  return [
    {
      ...row,
      kind: "modified",
      addedRanges: typingTextRanges(row.text),
    },
  ];
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

function atLineEnd(content: string, offset: number): boolean {
  return (
    offset === content.length || content[offset] === "\n" || content.startsWith("\r\n", offset)
  );
}

function lineStart(content: string, offset: number): number {
  return content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
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
