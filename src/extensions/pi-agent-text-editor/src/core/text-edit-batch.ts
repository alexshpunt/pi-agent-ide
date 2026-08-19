import { type FileMutationBatchResult, FileMutationResult } from "#src/api/mutation-result.js";
import { createUnifiedDiff } from "#src/core/mutation-result/diff.js";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";

import type { OriginalToolCall } from "#src/core/text-edit-batch-coordinator.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface TextBatchParams
{
    readonly edits: readonly TextBatchEntry[];
}

export interface TextBatchEntry extends Record<string, unknown>
{
    readonly callId: string;
    readonly op: string;
    readonly path: string;
}

export interface TextBatchDetails extends FileMutationBatchResult
{
    readonly callIdsByResult: readonly string[];
}

function resultPath(result: FileMutationResult): string | undefined
{
    return result.data.inputPath ?? result.data.path ?? result.files[0]?.path ?? result.errors[0]?.path;
}

export function splitTextBatchResult(
    aggregate: AgentToolResult<unknown>,
    calls: readonly OriginalToolCall[],
): ReadonlyMap<string, AgentToolResult<unknown>>
{
    const details = aggregate.details as TextBatchDetails | undefined;
    const resultsByCall = new Map(calls.map((call) => [call.id, [] as FileMutationResult[]]));

    for (const [index, result] of (details?.results ?? []).entries())
    {
        const callId = details?.callIdsByResult[index];

        if (callId !== undefined)
        {
            resultsByCall.get(callId)?.push(result);
        }
    }

    return new Map(calls.map((call) =>
    {
        const results = coalesceResults(resultsByCall.get(call.id) ?? []);
        return [
            call.id,
            {
                content: results.length === 0
                    ? []
                    : [new FileMutationAgentResult(results).toTextContent()],
                details: { results },
            },
        ];
    }));
}

function coalesceResults(results: readonly FileMutationResult[]): FileMutationResult[]
{
    const grouped = new Map<string, FileMutationResult[]>();
    const ungrouped: FileMutationResult[] = [];

    for (const result of results)
    {
        const path = resultPath(result);

        if (path === undefined || !result.ok)
        {
            ungrouped.push(result);
            continue;
        }

        const group = grouped.get(path) ?? [];
        group.push(result);
        grouped.set(path, group);
    }

    const merged = [...grouped].map(([path, group]) => mergePathResults(path, group));
    return [...merged, ...ungrouped];
}

function mergePathResults(path: string, results: readonly FileMutationResult[]): FileMutationResult
{
    const first = results[0]!;
    const last = results.at(-1)!;
    const before = first.beforeContentMap?.[path];
    const after = last.data.afterContent;

    if (results.length === 1 || typeof before !== "string" || typeof after !== "string")
    {
        return last;
    }

    const unified = createUnifiedDiff(path, before, after);
    const firstFile = first.files.find((file) => file.path === path);
    const lastFile = last.files.find((file) => file.path === path);
    return new FileMutationResult({
        ...last.data,
        diffs: [unified.diff],
        files: [firstFile ?? lastFile ?? { path, action: "edited" }],
        editCount: results.reduce((total, result) => total + (result.editCount ?? 0), 0),
        addedLines: unified.stats.added,
        removedLines: unified.stats.removed,
        beforeContentMap: { ...last.beforeContentMap, [path]: before },
        afterContent: after,
        afterDocument: last.data.afterDocument,
        warnings: results.flatMap((result) => result.warnings),
        hints: results.flatMap((result) => result.hints),
    });
}
