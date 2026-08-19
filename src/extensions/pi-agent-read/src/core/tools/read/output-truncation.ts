import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    truncateHead,
    type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { ReadRequest, ReadResultDetails, ReadToolResult } from "#src/api/tools/read.js";

export const READ_OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;

export const READ_OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;

export async function limitReadOutput(
    result: ReadToolResult,
    request: ReadRequest,
    saveFullOutput?: (text: string) => Promise<string>,
): Promise<ReadToolResult>
{
    const block = result.content.length === 1 ? result.content[0] : undefined;

    if (block?.type !== "text")
    {
        return result;
    }

    const truncation = truncateHead(block.text, {
        maxBytes: READ_OUTPUT_MAX_BYTES,
        maxLines: READ_OUTPUT_MAX_LINES,
    });

    if (truncation.truncated)
    {
        const temporarySource = saveFullOutput === undefined ? undefined : await saveFullOutput(block.text);
        const baseNotice = truncation.firstLineExceedsLimit
            ? oversizedFirstLineNotice(block.text, result.details, request)
            : truncatedOutputNotice(truncation, result.details, request);
        const notice = temporarySource === undefined
            ? baseNotice
            : appendTemporarySource(baseNotice, temporarySource);

        return {
            ...result,
            content: [{ ...block, text: appendNotice(truncation.content, notice) }],
            details: {
                ...truncatedDetails(result.details, truncation),
                ...(temporarySource === undefined ? {} : { temporarySource }),
            },
        };
    }

    const notice = explicitLimitNotice(result.details, request);

    if (notice === undefined)
    {
        return result;
    }

    return {
        ...result,
        content: [{ ...block, text: appendNotice(block.text, notice) }],
    };
}

function appendTemporarySource(notice: string, source: string): string
{
    return `${notice.slice(0, -1)} Full output: ${source}. Expires after 5 minutes of inactivity.]`;
}

function oversizedFirstLineNotice(text: string, details: ReadResultDetails, request: ReadRequest): string
{
    const firstLine = text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
    const lineSize = formatSize(Buffer.byteLength(firstLine, "utf8"));
    const sourceLine = sourceStartLine(details, request);
    const lineLabel = sourceLine === undefined ? "First output line" : `Line ${sourceLine}`;

    return `[${lineLabel} is ${lineSize}, exceeds ${formatSize(READ_OUTPUT_MAX_BYTES)} limit. `
        + "Use a source-specific tool to read this line in smaller byte ranges.]";
}

function truncatedOutputNotice(
    truncation: TruncationResult,
    details: ReadResultDetails,
    request: ReadRequest,
): string
{
    const sourceRange = shownSourceRange(truncation, details, request);

    if (sourceRange !== undefined && sourceRange.endLine < sourceRange.totalLines)
    {
        const byteLimit = truncation.truncatedBy === "bytes"
            ? ` (${formatSize(truncation.maxBytes)} limit)`
            : "";

        return `[Showing lines ${sourceRange.startLine}-${sourceRange.endLine} of ${sourceRange.totalLines}${byteLimit}. Use offset=${
            sourceRange.endLine + 1
        } to continue.]`;
    }

    const limit = truncation.truncatedBy === "lines"
        ? `${truncation.maxLines} line limit`
        : `${formatSize(truncation.maxBytes)} limit`;

    return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} rendered lines (${limit}). `
        + "Use a smaller line range to read this source.]";
}

function shownSourceRange(
    truncation: TruncationResult,
    details: ReadResultDetails,
    request: ReadRequest,
): { readonly startLine: number; readonly endLine: number; readonly totalLines: number; } | undefined
{
    const totalLines = details.totalLines;
    const startLine = sourceStartLine(details, request);

    if (totalLines === undefined || totalLines === 0 || startLine === undefined || truncation.outputLines === 0)
    {
        return undefined;
    }

    const projectedEndLine = details.endLine === undefined || details.endLine < startLine
        ? totalLines
        : details.endLine;
    const projectedLines = projectedEndLine - startLine + 1;
    const shownLines = Math.min(truncation.outputLines, projectedLines);

    return {
        startLine,
        endLine: startLine + shownLines - 1,
        totalLines,
    };
}

function explicitLimitNotice(details: ReadResultDetails, request: ReadRequest): string | undefined
{
    if (request.limit === undefined || details.totalLines === undefined || details.totalLines === 0)
    {
        return undefined;
    }

    const startLine = sourceStartLine(details, request);

    if (startLine === undefined)
    {
        return undefined;
    }

    const nextOffset = details.endLine === undefined || details.endLine < startLine
        ? startLine
        : details.endLine + 1;

    if (nextOffset > details.totalLines)
    {
        return undefined;
    }

    const remaining = details.totalLines - nextOffset + 1;
    return `[${remaining} more lines in source. Use offset=${nextOffset} to continue.]`;
}

function sourceStartLine(details: ReadResultDetails, request: ReadRequest): number | undefined
{
    if (details.startLine !== undefined && details.startLine > 0)
    {
        return details.startLine;
    }

    if (details.totalLines === undefined || details.totalLines === 0)
    {
        return undefined;
    }

    const offset = request.offset === undefined ? 1 : Math.trunc(request.offset);
    return offset < 0
        ? Math.max(1, details.totalLines + offset + 1)
        : Math.max(1, offset);
}

function truncatedDetails(details: ReadResultDetails, truncation: TruncationResult): ReadResultDetails
{
    return {
        ...details,
        ...(details.lines === undefined ? {} : { lines: details.lines.slice(0, truncation.outputLines) }),
        truncation,
    };
}

function appendNotice(text: string, notice: string): string
{
    return text.length === 0 ? notice : `${text}\n\n${notice}`;
}
