import { createTwoFilesPatch, diffLines } from "diff";

export interface DiffStats
{
    removed: number;
    added: number;
}

export interface UnifiedDiffResult
{
    diff: string;
    stats: DiffStats;
}

export function createUnifiedDiff(path: string, beforeContent: string, afterContent: string): UnifiedDiffResult
{
    const diff = createTwoFilesPatch(path, path, beforeContent, afterContent, "", "", { context: 3 })
        .replace(/^Index: .*\n={3,}\n?/m, "")
        .trimEnd();

    return { diff, stats: computeStats(beforeContent, afterContent) };
}

function computeStats(beforeContent: string, afterContent: string): DiffStats
{
    let removed = 0;
    let added = 0;

    for (const part of diffLines(beforeContent, afterContent))
    {
        const lineCount = countDiffLines(part.value);

        if (part.removed)
        {
            removed += lineCount;
        }

        if (part.added)
        {
            added += lineCount;
        }
    }

    return { removed, added };
}

function countDiffLines(value: string): number
{
    if (value.length === 0)
    {
        return 0;
    }

    const normalized = value.replaceAll("\r\n", "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}

export interface ChangedRange
{
    /** 1-based, inclusive — line number in the AFTER file */
    start: number;
    /** 1-based, inclusive — line number in the AFTER file */
    end: number;
}

/**
 * Compute the line ranges that changed in the AFTER file compared to the
 * BEFORE file. Returns 1-based inclusive ranges in the AFTER file's line
 * numbering. Adjacent ranges are merged into single islands.
 */
export function computeChangedRanges(beforeContent: string, afterContent: string): ChangedRange[]
{
    const parts = diffLines(beforeContent, afterContent);
    const ranges: ChangedRange[] = [];
    let afterLine = 0;

    for (const part of parts)
    {
        const lineCount = countDiffLines(part.value);

        if (lineCount === 0)
        {
            continue;
        }

        if (part.removed)
        {
            // removed lines do not advance the AFTER cursor
            continue;
        }

        if (part.added)
        {
            ranges.push({ start: afterLine + 1, end: afterLine + lineCount });
        }

        afterLine += lineCount;
    }

    return mergeAdjacentRanges(ranges);
}

function mergeAdjacentRanges(ranges: ChangedRange[]): ChangedRange[]
{
    if (ranges.length === 0)
    {
        return [];
    }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged: ChangedRange[] = [sorted[0]!];

    for (let i = 1; i < sorted.length; i++)
    {
        const last = merged.at(-1)!;
        const cur = sorted[i]!;

        if (cur.start <= last.end + 1)
        {
            last.end = Math.max(last.end, cur.end);
        }
        else
        {
            merged.push(cur);
        }
    }

    return merged;
}
