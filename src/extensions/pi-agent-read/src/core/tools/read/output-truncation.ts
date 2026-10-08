import { stat } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { ReadRequest, ReadResultDetails, ReadToolResult } from "#src/api/tools/read.js";
import { anchoredStartLine } from "#src/core/tools/read/read-result.js";

export interface ReadTruncationOptions {
  /** Absolute 1-based line where an anchored read's window starts. */
  readonly originLine?: number;
}

export const READ_OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;

export const READ_OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;

export async function limitReadOutput(
  result: ReadToolResult,
  request: ReadRequest,
  saveFullOutput?: (text: string) => Promise<string>,
  options?: ReadTruncationOptions,
): Promise<ReadToolResult> {
  const originLine = options?.originLine;
  const block = result.content.length === 1 ? result.content[0] : undefined;

  if (block?.type !== "text") {
    return result;
  }

  const truncation = truncateHead(block.text, {
    maxBytes: READ_OUTPUT_MAX_BYTES,
    maxLines: READ_OUTPUT_MAX_LINES,
  });

  if (truncation.truncated) {
    const temporarySource =
      saveFullOutput === undefined ? undefined : await saveFullOutput(block.text);
    const baseNotice = truncation.firstLineExceedsLimit
      ? await oversizedFirstLineNotice(block.text, result.details, request)
      : truncatedOutputNotice(truncation, result.details, request, originLine);
    const notice =
      temporarySource === undefined
        ? baseNotice
        : appendTemporarySource(baseNotice, temporarySource);

    return {
      ...result,
      content: [{ ...block, text: appendNotice(truncation.content, notice) }],
      details: {
        ...truncatedDetails(result.details, truncation),
        outputNotice: (truncation.content.length ? "\n\n" : "") + notice,
        ...(temporarySource !== undefined && { temporarySource }),
      },
    };
  }

  return explainReadWindow(result, request, options);
}

/** Explains an empty or explicitly limited text window without changing its source selection. */
export function explainReadWindow(
  result: ReadToolResult,
  request: ReadRequest,
  options?: ReadTruncationOptions,
): ReadToolResult {
  const block = result.content.length === 1 ? result.content[0] : undefined;
  if (result.isError || block?.type !== "text") return result;
  const notice =
    block.text.length === 0
      ? emptyTextNotice(result, request, options?.originLine)
      : explicitLimitNotice(result.details, request, options?.originLine);
  if (notice === undefined) return result;
  return {
    ...result,
    content: [{ ...block, text: appendNotice(block.text, notice) }],
    details: { ...result.details, outputNotice: (block.text.length ? "\n\n" : "") + notice },
  };
}

function emptyTextNotice(
  result: ReadToolResult,
  request: ReadRequest,
  originLine: number | undefined,
): string | undefined {
  const selected = result.script;
  if (result.isError || selected?.kind !== "text" || selected.lines.length !== 0) return undefined;
  if (selected.totalLines === 0) return "[Empty source.]";
  if (request.limit !== undefined && Math.trunc(request.limit) <= 0)
    return "[No lines selected: limit=0.]";
  const offset = Math.trunc(request.offset ?? 1);
  if (anchoredStartLine(offset, selected.totalLines, originLine) > selected.totalLines)
    return `[Offset ${offset} is beyond the end of the source (${selected.totalLines} ${selected.totalLines === 1 ? "line" : "lines"}).]`;
  return undefined;
}
function appendTemporarySource(notice: string, source: string): string {
  const reference = source.startsWith("temp:") ? source : JSON.stringify(source);
  return `${notice.slice(0, -1)} Full output: ${reference}. Available until this runtime is disposed.]`;
}

async function oversizedFirstLineNotice(
  text: string,
  details: ReadResultDetails,
  request: ReadRequest,
): Promise<string> {
  const firstLine = text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
  const lineSize = formatSize(Buffer.byteLength(firstLine, "utf8"));
  const sourceLine = sourceStartLine(details, request);
  const lineLabel = sourceLine === undefined ? "First output line" : `Line ${sourceLine}`;
  const limit = formatSize(READ_OUTPUT_MAX_BYTES);

  if (
    details.resolvedBy === "filesystem" &&
    request.views?.some((view) => view.startsWith("jq:")) === true
  ) {
    return (
      `[Output line ${sourceLine ?? 1} is ${lineSize}, exceeds the ${limit} output limit. ` +
      "This line was not returned. Narrow the jq filter to return a smaller value.]"
    );
  }

  if (details.resolvedBy === "filesystem" && details.source !== undefined) {
    const file = await stat(details.source).catch(() => undefined);
    if (file?.isFile() === true) {
      return (
        `[${lineLabel} is ${lineSize}, exceeds the ${limit} output limit. This line was not returned. ` +
        `Read ${JSON.stringify(`raw:${details.source}`)} with offset=0 and limit=4096 to inspect the original bytes.]`
      );
    }
  }

  return (
    `[${lineLabel} is ${lineSize}, exceeds ${limit} limit. ` +
    "Use a source-specific tool to read this line in smaller byte ranges.]"
  );
}

function truncatedOutputNotice(
  truncation: TruncationResult,
  details: ReadResultDetails,
  request: ReadRequest,
  originLine?: number,
): string {
  const sourceRange = shownSourceRange(truncation, details, request);

  if (sourceRange !== undefined && sourceRange.endLine < sourceRange.totalLines) {
    const limit =
      truncation.truncatedBy === "lines"
        ? `${truncation.maxLines}-line limit`
        : `${formatSize(truncation.maxBytes)} limit`;
    const action = sourceContinuationAction(details, request, sourceRange.endLine + 1, originLine);

    return `[Showing lines ${sourceRange.startLine}-${sourceRange.endLine} of ${sourceRange.totalLines} (${limit}). ${action} to continue.]`;
  }

  const limit =
    truncation.truncatedBy === "lines"
      ? `${truncation.maxLines}-line limit`
      : `${formatSize(truncation.maxBytes)} limit`;

  return (
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} output lines (${limit}). ` +
    "No single source-line continuation is available. " +
    "Retry Read with a smaller limit, keeping the same source and views.]"
  );
}

function shownSourceRange(
  truncation: TruncationResult,
  details: ReadResultDetails,
  request: ReadRequest,
):
  | { readonly startLine: number; readonly endLine: number; readonly totalLines: number }
  | undefined {
  const totalLines = details.totalLines;
  const startLine = sourceStartLine(details, request);

  if (
    totalLines === undefined ||
    totalLines === 0 ||
    startLine === undefined ||
    truncation.outputLines === 0
  ) {
    return undefined;
  }

  const projectedEndLine =
    details.endLine === undefined || details.endLine < startLine ? totalLines : details.endLine;
  const projectedLines = projectedEndLine - startLine + 1;
  const shownLines = Math.min(truncation.outputLines, projectedLines);

  return {
    startLine,
    endLine: startLine + shownLines - 1,
    totalLines,
  };
}

function explicitLimitNotice(
  details: ReadResultDetails,
  request: ReadRequest,
  originLine?: number,
): string | undefined {
  if (request.limit === undefined || details.totalLines === undefined || details.totalLines === 0) {
    return undefined;
  }

  const startLine = sourceStartLine(details, request);

  if (startLine === undefined) {
    return undefined;
  }

  const nextAbsolute =
    details.endLine === undefined || details.endLine < startLine ? startLine : details.endLine + 1;

  if (nextAbsolute > details.totalLines) {
    return undefined;
  }

  const remaining = details.totalLines - nextAbsolute + 1;
  const lineLabel = remaining === 1 ? "line" : "lines";
  const action = sourceContinuationAction(details, request, nextAbsolute, originLine);
  return `[${remaining} more ${lineLabel} in source. ${action} to continue.]`;
}

function sourceContinuationAction(
  details: ReadResultDetails,
  request: ReadRequest,
  nextAbsolute: number,
  originLine: number | undefined,
): string {
  const action =
    details.source === undefined
      ? `Use offset=${continuationOffset(nextAbsolute, originLine)}`
      : `Read ${JSON.stringify(details.source)} with offset=${nextAbsolute}`;
  const views =
    request.views === undefined || request.views.length === 0
      ? ""
      : ` and views=${JSON.stringify(request.views)}`;
  return action + views;
}

/** Converts an absolute next line into the offset the agent should send again. */
function continuationOffset(absoluteNextLine: number, originLine: number | undefined): number {
  return originLine === undefined ? absoluteNextLine : absoluteNextLine - originLine + 1;
}

function sourceStartLine(details: ReadResultDetails, request: ReadRequest): number | undefined {
  if (details.startLine !== undefined && details.startLine > 0) {
    return details.startLine;
  }

  if (details.totalLines === undefined || details.totalLines === 0) {
    return undefined;
  }

  const offset = request.offset === undefined ? 1 : Math.trunc(request.offset);
  return offset < 0 ? Math.max(1, details.totalLines + offset + 1) : Math.max(1, offset);
}

function truncatedDetails(
  details: ReadResultDetails,
  truncation: TruncationResult,
): ReadResultDetails {
  return {
    ...details,
    ...(details.lines !== undefined && { lines: details.lines.slice(0, truncation.outputLines) }),
    truncation,
  };
}

function appendNotice(text: string, notice: string): string {
  return text.length === 0 ? notice : `${text}\n\n${notice}`;
}
