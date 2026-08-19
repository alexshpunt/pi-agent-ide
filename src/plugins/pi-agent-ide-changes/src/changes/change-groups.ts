import { createHash } from "node:crypto";

import { diffLines } from "diff";

import type { ChangeGroup, ChangeSegment, ChangeState } from "./change-types.js";

const CONTEXT_LINE_COUNT = 3;
const MINIMUM_SELECTOR_LENGTH = 4;

interface RawChange
{
    readonly headStart: number;
    readonly headEnd: number;
    readonly currentStart: number;
    readonly currentEnd: number;
}

interface ProjectedRange
{
    readonly start: number;
    readonly end: number;
}

export function createChangeGroups(
    repositoryPath: string,
    headText: string,
    indexText: string,
    worktreeText: string,
): ChangeGroup[]
{
    const rawChanges = collectRawChanges(headText, worktreeText);
    const mergedChanges = mergeNearbyChanges(rawChanges, headText, worktreeText);
    const indexChanges = collectRawChanges(headText, indexText);
    const duplicateCounts = new Map<string, number>();
    const groups = mergedChanges.map((change) =>
    {
        const segment = createSegment(change, headText, indexText, worktreeText, indexChanges);
        const contextBefore = linesBefore(worktreeText, change.currentStart);
        const contextAfter = linesAfter(worktreeText, change.currentEnd);
        const canonicalContent = JSON.stringify({
            contextAfter,
            contextBefore,
            headText: segment.headText,
            repositoryPath,
            worktreeText: segment.worktreeText,
        });
        const duplicateOrder = duplicateCounts.get(canonicalContent) ?? 0;
        duplicateCounts.set(canonicalContent, duplicateOrder + 1);
        const digest = sha256(`${canonicalContent}\0${duplicateOrder}`).toUpperCase();

        return {
            selector: digest,
            digest,
            duplicateOrder,
            repositoryPath,
            state: changeState(segment),
            currentStartLine: lineAtOffset(worktreeText, change.currentStart),
            currentEndLine: lineAtOffset(worktreeText, Math.max(change.currentStart, change.currentEnd - 1)),
            contextBefore,
            contextAfter,
            canonicalContent,
            segments: [segment],
        } satisfies ChangeGroup;
    });

    return groups.map((group) => ({
        ...group,
        selector: `CHANGE#${shortestUniquePrefix(group.digest, groups.map(({ digest }) => digest))}`,
    }));
}

export function reverseChangeGroup(worktreeText: string, group: ChangeGroup): string | undefined
{
    let result = worktreeText;

    for (const segment of [...group.segments].sort((left, right) => right.currentStart - left.currentStart))
    {
        if (result.slice(segment.currentStart, segment.currentEnd) !== segment.worktreeText)
        {
            return undefined;
        }

        result = result.slice(0, segment.currentStart) + segment.headText + result.slice(segment.currentEnd);
    }

    return result;
}

export function replaceHeadRangeInIndex(
    headText: string,
    indexText: string,
    headStart: number,
    headEnd: number,
    replacementText: string,
): string
{
    const projected = projectHeadRange(headStart, headEnd, collectRawChanges(headText, indexText));
    return indexText.slice(0, projected.start) + replacementText + indexText.slice(projected.end);
}

function createSegment(
    change: RawChange,
    headText: string,
    indexText: string,
    worktreeText: string,
    indexChanges: readonly RawChange[],
): ChangeSegment
{
    const indexRange = projectHeadRange(change.headStart, change.headEnd, indexChanges);

    return {
        headText: headText.slice(change.headStart, change.headEnd),
        indexText: indexText.slice(indexRange.start, indexRange.end),
        worktreeText: worktreeText.slice(change.currentStart, change.currentEnd),
        headStart: change.headStart,
        headEnd: change.headEnd,
        indexStart: indexRange.start,
        indexEnd: indexRange.end,
        currentStart: change.currentStart,
        currentEnd: change.currentEnd,
    };
}

function changeState(segment: ChangeSegment): ChangeState
{
    if (segment.indexText === segment.worktreeText)
    {
        return "staged";
    }

    return segment.indexText === segment.headText ? "unstaged" : "partial";
}

function collectRawChanges(headText: string, currentText: string): RawChange[]
{
    const parts = diffLines(headText, currentText);
    const changes: RawChange[] = [];
    let headOffset = 0;
    let currentOffset = 0;
    let index = 0;

    while (index < parts.length)
    {
        const part = parts[index]!;

        if (!part.added && !part.removed)
        {
            headOffset += part.value.length;
            currentOffset += part.value.length;
            index++;
            continue;
        }

        const start = { head: headOffset, current: currentOffset };

        while (index < parts.length && (parts[index]!.added || parts[index]!.removed))
        {
            const changedPart = parts[index]!;

            if (changedPart.removed)
            {
                headOffset += changedPart.value.length;
            }
            else
            {
                currentOffset += changedPart.value.length;
            }

            index++;
        }

        changes.push({
            headStart: start.head,
            headEnd: headOffset,
            currentStart: start.current,
            currentEnd: currentOffset,
        });
    }

    return changes;
}

function mergeNearbyChanges(
    changes: readonly RawChange[],
    headText: string,
    worktreeText: string,
): RawChange[]
{
    const merged: RawChange[] = [];

    for (const change of changes)
    {
        const previous = merged.at(-1);

        if (
            previous !== undefined
            && lineBreakCount(worktreeText.slice(previous.currentEnd, change.currentStart)) <= CONTEXT_LINE_COUNT * 2
            && lineBreakCount(headText.slice(previous.headEnd, change.headStart)) <= CONTEXT_LINE_COUNT * 2
        )
        {
            merged[merged.length - 1] = {
                headStart: previous.headStart,
                headEnd: change.headEnd,
                currentStart: previous.currentStart,
                currentEnd: change.currentEnd,
            };
            continue;
        }

        merged.push(change);
    }

    return merged;
}

function projectHeadRange(
    headStart: number,
    headEnd: number,
    changes: readonly RawChange[],
): ProjectedRange
{
    return {
        start: projectHeadBoundary(headStart, "start", changes),
        end: projectHeadBoundary(headEnd, "end", changes),
    };
}

function projectHeadBoundary(
    offset: number,
    side: "end" | "start",
    changes: readonly RawChange[],
): number
{
    let delta = 0;

    for (const change of changes)
    {
        if (offset < change.headStart)
        {
            return offset + delta;
        }

        const insertion = change.headStart === change.headEnd;

        if (insertion && offset === change.headStart)
        {
            return side === "start" ? change.currentStart : change.currentEnd;
        }

        if (offset === change.headStart)
        {
            return change.currentStart;
        }

        if (offset < change.headEnd)
        {
            return side === "start" ? change.currentStart : change.currentEnd;
        }

        if (offset === change.headEnd)
        {
            return change.currentEnd;
        }

        delta = change.currentEnd - change.headEnd;
    }

    return offset + delta;
}

function linesBefore(text: string, offset: number): string[]
{
    return text.slice(0, offset).split(/(?<=\n)/u).filter(Boolean).slice(-CONTEXT_LINE_COUNT);
}

function linesAfter(text: string, offset: number): string[]
{
    return text.slice(offset).split(/(?<=\n)/u).filter(Boolean).slice(0, CONTEXT_LINE_COUNT);
}

function lineAtOffset(text: string, offset: number): number
{
    return lineBreakCount(text.slice(0, offset)) + 1;
}

function lineBreakCount(text: string): number
{
    return [...text.matchAll(/\n/gu)].length;
}

function sha256(value: string): string
{
    return createHash("sha256").update(value).digest("hex");
}

function shortestUniquePrefix(digest: string, allDigests: readonly string[]): string
{
    for (let length = MINIMUM_SELECTOR_LENGTH; length <= digest.length; length++)
    {
        const prefix = digest.slice(0, length);

        if (allDigests.filter((candidate) => candidate.startsWith(prefix)).length === 1)
        {
            return prefix;
        }
    }

    return digest;
}
