import { createDiffModel, type DiffModel, type DiffRow } from "./diff-model.js";

import type { MutationRenderResource } from "./render-resource.js";
import type { TextMutationPreviewRange, TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

interface FrozenLineWindow
{
    readonly beforeStart: number;
    readonly beforeEnd: number;
    readonly afterStart: number;
    readonly afterEnd: number;
    readonly omittedBefore?: number;
}

interface FrozenResourceViewport
{
    readonly path: string;
    readonly windows: readonly FrozenLineWindow[];
    readonly focusAfterLine?: number;
}

export interface FrozenMutationViewports
{
    readonly resources: readonly FrozenResourceViewport[];
}

export function freezeMutationViewports(
    resources: readonly MutationRenderResource[],
): FrozenMutationViewports
{
    return {
        resources: resources.flatMap((resource) =>
        {
            const model = resource.model
                ?? createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges);
            const windows = freezeWindows(model, resource);
            const focusAfterLine = model.rows[model.focusRow]?.afterLine;
            return windows.length === 0
                ? []
                : [{
                    path: resource.path,
                    windows,
                    ...(focusAfterLine === undefined ? {} : { focusAfterLine }),
                }];
        }),
    };
}

export function projectFinalResources(
    resources: readonly TextMutationPreviewResource[],
    frozen: FrozenMutationViewports | undefined,
): readonly MutationRenderResource[]
{
    return resources.map((resource) =>
    {
        const viewport = frozen?.resources.find((candidate) => samePath(candidate.path, resource.path));

        if (viewport === undefined)
        {
            return {
                ...resource,
                model: createDiffModel(resource.beforeContent, resource.afterContent, resource.ranges),
            };
        }

        return {
            ...resource,
            model: createFrozenModel(resource.beforeContent, resource.afterContent, viewport),
        };
    });
}

function freezeWindows(model: DiffModel, resource: TextMutationPreviewResource): FrozenLineWindow[]
{
    const windows: FrozenLineWindow[] = [];
    let group: DiffRow[] = [];
    let omittedBefore: number | undefined;

    const flush = (): void =>
    {
        if (group.length === 0)
        {
            return;
        }

        const beforeLines = group.flatMap((row) => row.beforeLine === undefined ? [] : [row.beforeLine]);
        const afterLines = group.flatMap((row) => row.afterLine === undefined ? [] : [row.afterLine]);
        const beforeAnchor = lineAtRange(resource.beforeContent, resource.beforeRanges?.at(-1));
        const afterAnchor = lineAtRange(resource.afterContent, resource.ranges.at(-1));
        const beforeStart = beforeLines.length === 0 ? beforeAnchor - 1 : Math.min(...beforeLines) - 1;
        const afterStart = afterLines.length === 0 ? afterAnchor - 1 : Math.min(...afterLines) - 1;
        const beforeEnd = beforeLines.length === 0 ? beforeStart : Math.max(...beforeLines);
        const afterEnd = afterLines.length === 0 ? afterStart : Math.max(...afterLines);
        windows.push({
            beforeStart,
            beforeEnd,
            afterStart,
            afterEnd,
            ...(omittedBefore === undefined ? {} : { omittedBefore }),
        });
        group = [];
        omittedBefore = undefined;
    };

    for (const row of model.rows)
    {
        if (row.kind === "omitted")
        {
            flush();
            omittedBefore = row.omitted;
        }
        else
        {
            group.push(row);
        }
    }

    flush();
    return windows;
}

function createFrozenModel(beforeContent: string, afterContent: string, viewport: FrozenResourceViewport): DiffModel
{
    const beforeLines = contentLines(beforeContent);
    const afterLines = contentLines(afterContent);
    const rows: DiffRow[] = [];

    for (const window of viewport.windows)
    {
        if (window.omittedBefore !== undefined && rows.length > 0)
        {
            rows.push({ kind: "omitted", text: "", changed: false, omitted: window.omittedBefore });
        }

        const beforeStart = Math.min(window.beforeStart, beforeLines.length);
        const beforeEnd = Math.min(window.beforeEnd, beforeLines.length);
        const afterStart = Math.min(window.afterStart, afterLines.length);
        const afterEnd = Math.min(window.afterEnd, afterLines.length);
        const model = createDiffModel(
            beforeLines.slice(beforeStart, beforeEnd).join("\n"),
            afterLines.slice(afterStart, afterEnd).join("\n"),
            [],
            {
                beforeLineOffset: beforeStart,
                afterLineOffset: afterStart,
                project: false,
                ...(viewport.focusAfterLine === undefined ? {} : { focusAfterLine: viewport.focusAfterLine }),
            },
        );
        rows.push(...model.rows);
    }

    const focusRow = focusRowAt(rows, viewport.focusAfterLine);
    return {
        rows,
        added: rows.filter(({ kind }) => kind === "added").length,
        modified: rows.filter(({ kind }) => kind === "modified").length,
        removed: rows.filter(({ kind }) => kind === "removed").length,
        focusRow,
    };
}

function contentLines(content: string): string[]
{
    if (content.length === 0)
    {
        return [];
    }

    const normalized = content.replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");

    if (normalized.endsWith("\n"))
    {
        lines.pop();
    }

    return lines;
}

function lineAtRange(content: string, range: TextMutationPreviewRange | undefined): number
{
    const offset = range?.from ?? 0;
    return content.slice(0, offset).split("\n").length;
}

function focusRowAt(rows: readonly DiffRow[], line: number | undefined): number
{
    if (line !== undefined)
    {
        const exact = rows.findLastIndex((row) => row.afterLine !== undefined && row.afterLine <= line);

        if (exact !== -1)
        {
            return exact;
        }
    }

    return Math.max(0, rows.findLastIndex(({ changed }) => changed));
}

function samePath(left: string, right: string): boolean
{
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}
