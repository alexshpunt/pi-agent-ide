import { type TextSourceLine, withTextSourceLine } from "pi-agent-text";

import type { ReadHandler } from "pi-agent-read/api/tools/read";

export interface SourceViewLine
{
    readonly content: string;
    readonly sourceLine?: TextSourceLine;
    readonly suffix?: string;
}

export interface RenderedSourceViewLine
{
    readonly text: string;
    readonly sourceLine?: TextSourceLine;
}

export interface SourceViewBlock
{
    readonly path: string;
    readonly heading?: string;
    readonly details?: readonly string[];
    readonly startLine: number;
    readonly endLine: number;
    readonly totalLines: number;
    readonly renderedLines: readonly RenderedSourceViewLine[];
    readonly status?: "ok" | "failed";
    readonly error?: string;
    readonly code?: string;
    readonly warning?: string;
    readonly continuation?: string;
}

export interface SourceViewFormatOptions
{
    readonly failureLabel: string;
    readonly emptyReason: string;
    readonly includeNoChange?: boolean;
    readonly recovery?: readonly string[];
    readonly unknownFailure?: string;
}

export interface SourceMappedTextContent
{
    readonly type: "text";
    readonly text: string;
    readonly sourceLines: Readonly<Record<string, TextSourceLine>>;
}

export function renderSourceViewLine(line: SourceViewLine): RenderedSourceViewLine
{
    return {
        text: `${line.content}${line.suffix ?? ""}`,
        ...(line.sourceLine === undefined ? {} : { sourceLine: line.sourceLine }),
    };
}

export function formatSourceViewResults(
    results: readonly SourceViewBlock[],
    options: SourceViewFormatOptions,
): SourceMappedTextContent
{
    if (results.length === 0)
    {
        return sourceMappedContent([{ text: "<empty-result>" }]);
    }

    if (results.length === 1 && results[0]!.status === "failed" && results[0]!.path === "")
    {
        const result = results[0]!;
        const recovery = options.recovery === undefined
            ? []
            : ["", "Recovery:", ...options.recovery];
        const noChange = options.includeNoChange === true ? ["", "No file was changed."] : [];

        return sourceMappedContent(
            [
                result.code ?? options.failureLabel,
                "",
                `Reason: ${result.error ?? options.unknownFailure ?? "unknown failure"}`,
                ...noChange,
                ...recovery,
            ].map((text) => ({ text })),
        );
    }

    const lines: RenderedSourceViewLine[] = [];

    for (const [index, result] of results.entries())
    {
        if (index > 0)
        {
            lines.push({ text: "" }, { text: "" });
        }

        lines.push(...formatSourceViewBlock(result, options));
    }

    return sourceMappedContent(lines);
}

export function createSourceMappedTextReadHandler(): ReadHandler
{
    return (context) =>
    {
        const state = context.state;

        if (state?.contentKind !== "text")
        {
            return { kind: "continue", context };
        }

        const sourceLines = sourceLineMap(state.content[0]);

        if (sourceLines === undefined)
        {
            return { kind: "continue", context };
        }

        const lines = state.text.lines.map((line) =>
        {
            const sourceLine = sourceLines[String(line.lineNumber)];
            return sourceLine === undefined ? line : withTextSourceLine(line, sourceLine);
        });

        return {
            kind: "continue",
            context: {
                ...context,
                state: {
                    ...state,
                    text: { ...state.text, lines },
                },
            },
        };
    };
}

function formatSourceViewBlock(
    result: SourceViewBlock,
    options: SourceViewFormatOptions,
): RenderedSourceViewLine[]
{
    if (result.status === "failed")
    {
        const heading = result.heading === undefined
            ? [`## file: ${result.path || "<unknown>"}`]
            : [`## ${result.heading}`, ...(result.details ?? [])];

        return [
            ...heading,
            `${options.failureLabel} | ${result.error ?? options.unknownFailure ?? "unknown failure"}`,
        ].map((text) => ({ text }));
    }

    const heading = result.heading === undefined
        ? [`## file: ${result.path}`]
        : [`## ${result.heading}`, ...(result.details ?? [])];
    const continuation = result.continuation ?? "";
    const warning = result.warning === undefined ? [] : [{ text: "" }, { text: result.warning }];

    return [
        ...heading.map((text) => ({ text })),
        { text: `Lines: ${result.startLine}-${result.endLine} of ${result.totalLines}${continuation}` },
        { text: "" },
        ...result.renderedLines,
        ...warning,
    ];
}

function sourceMappedContent(lines: readonly RenderedSourceViewLine[]): SourceMappedTextContent
{
    const sourceLines: Record<string, TextSourceLine> = {};

    for (const [index, line] of lines.entries())
    {
        if (line.sourceLine !== undefined)
        {
            sourceLines[String(index + 1)] = line.sourceLine;
        }
    }

    return {
        type: "text",
        text: lines.map((line) => line.text).join("\n"),
        sourceLines,
    };
}

function sourceLineMap(content: unknown): Readonly<Record<string, TextSourceLine>> | undefined
{
    if (typeof content !== "object" || content === null || !("sourceLines" in content))
    {
        return undefined;
    }

    const sourceLines = (content as { readonly sourceLines?: unknown; }).sourceLines;

    if (typeof sourceLines !== "object" || sourceLines === null)
    {
        return undefined;
    }

    for (const value of Object.values(sourceLines))
    {
        if (!isTextSourceLine(value))
        {
            return undefined;
        }
    }

    return sourceLines as Readonly<Record<string, TextSourceLine>>;
}

function isTextSourceLine(value: unknown): value is TextSourceLine
{
    if (typeof value !== "object" || value === null)
    {
        return false;
    }

    const line = value as Partial<TextSourceLine>;

    return typeof line.source === "string"
        && line.source.length > 0
        && Number.isInteger(line.lineNumber)
        && (line.lineNumber ?? 0) > 0
        && typeof line.content === "string";
}
