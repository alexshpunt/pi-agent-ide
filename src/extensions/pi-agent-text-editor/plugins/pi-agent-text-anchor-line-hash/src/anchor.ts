import { createHash } from "node:crypto";

import {
    TextAnchor,
    type TextAnchorResolutionAttempt,
    type TextAnchorResolver,
    type TextAnchorResolverContext,
} from "pi-agent-text";

const lineHashPattern = /^([1-9]\d*)#([A-Z0-9]{3,4})$/;
const presentedLineHashPattern = /(?<![A-Za-z0-9])([1-9]\d*#[A-Z0-9]{3,4})(?![A-Za-z0-9])/g;

function normalizeLineHashAnchor(value: string): string
{
    const matches = [...value.matchAll(presentedLineHashPattern)];
    return matches.length === 1 ? matches[0]![1]! : value;
}

class LineHashTextAnchor extends TextAnchor
{
    public constructor(lineNumber: number, line: string)
    {
        super(`${lineNumber}#${hashLine(line)}`, lineNumber);
    }
}

export function hashLine(line: string): string
{
    return createHash("sha1").update(line).digest("hex").slice(0, 4).toUpperCase();
}

export function createLineHashAnchor(lineNumber: number, line: string): TextAnchor
{
    return new LineHashTextAnchor(lineNumber, line);
}

export function formatLineHashAnchor(lineNumber: number, line: string): string
{
    return createLineHashAnchor(lineNumber, line).value;
}

export function renderLineHashLines(
    lines: readonly string[],
    startLine = 1,
    endLine = lines.length,
): string[]
{
    const first = Math.max(1, startLine);
    const last = Math.min(lines.length, endLine);

    if (last < first)
    {
        return [];
    }

    const anchors = lines.map((line, index) => formatLineHashAnchor(index + 1, line));
    const width = Math.max(0, ...anchors.map((anchor) => anchor.length));

    return lines
        .slice(first - 1, last)
        .map((line, index) => `${anchors[first + index - 1]!.padStart(width)}|${line}`);
}

export function createLineHashAnchorResolver(): TextAnchorResolver
{
    return {
        id: "line-hash",
        description:
            "Use the complete `LINE#HASH` printed before a source line, for example `12#A4F0`; the hash rejects stale text.",
        normalize: normalizeLineHashAnchor,
        tryResolve(value, context)
        {
            return Promise.resolve(resolveLineHashAnchor(value, context));
        },
    };
}

function resolveLineHashAnchor(
    value: string,
    context: TextAnchorResolverContext,
): TextAnchorResolutionAttempt
{
    const match = lineHashPattern.exec(value);

    if (match === null)
    {
        return { kind: "not-handled" };
    }

    const lineNumber = Number(match[1]);
    const line = context.lines[lineNumber - 1];

    if (line === undefined || hashLine(line) !== match[2])
    {
        const nearbyLineCount = 5;
        const first = Math.max(1, lineNumber - nearbyLineCount);
        const last = Math.min(context.lines.length, lineNumber + nearbyLineCount);

        return {
            kind: "rejected",
            rejection: {
                code: line === undefined ? "missing" : "stale",
                reason: line === undefined ? "line hash anchor is out of range" : "line hash anchor is stale",
                contextRange: { offset: first, limit: last - first + 1 },
            },
        };
    }

    return { kind: "resolved", anchor: createLineHashAnchor(lineNumber, line) };
}
