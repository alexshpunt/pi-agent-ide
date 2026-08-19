import { diffLines } from "diff";

import { ChangeService } from "#src/changes/change-service.js";

import type { ChangeGroup } from "#src/changes/change-types.js";
import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import type { PresentedTextRow, TextDocument, TextLine, TextLinePresenter } from "pi-agent-text";

const FILESYSTEM_RESOLVER_ID = "filesystem";

interface LineHunkPresentation
{
    readonly before: PresentedTextRow[];
    readonly after: PresentedTextRow[];
    readonly annotations: string[];
    added: boolean;
}

type HunkBoundaryTarget =
    | { readonly kind: "current"; readonly lineNumber: number; }
    | { readonly kind: "synthetic"; readonly rows: PresentedTextRow[]; readonly index: number; };

export function createCurrentChangePresenter(executor: GitCommandExecutor): TextLinePresenter
{
    return {
        id: "current-git-changes",
        async present(document, context)
        {
            if (context.purpose !== "read" || context.resolvedBy !== FILESYSTEM_RESOLVER_ID)
            {
                return document;
            }

            const creation = await ChangeService.create(executor, context.cwd, context.signal);

            if (creation.status !== "ready")
            {
                return document;
            }

            const inspection = await creation.service.inspect({
                source: context.source,
                worktreeText: document.content,
                cwd: context.cwd,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            });

            if (inspection.status !== "applicable")
            {
                return document;
            }

            return presentChangeGroups(document, inspection.groups);
        },
    };
}

function presentChangeGroups(document: TextDocument, groups: readonly ChangeGroup[]): TextDocument
{
    const presentations = new Map<number, LineHunkPresentation>();

    for (const group of groups)
    {
        presentChangeGroup(document, group, presentations);
    }

    return {
        ...document,
        lines: document.lines.map((line) => presentLine(line, presentations.get(line.lineNumber))),
    };
}

function presentChangeGroup(
    document: TextDocument,
    group: ChangeGroup,
    presentations: Map<number, LineHunkPresentation>,
): void
{
    const segment = group.segments[0]!;
    const parts = diffLines(segment.headText, segment.worktreeText);
    let currentLine = group.currentStartLine;
    let firstTarget: HunkBoundaryTarget | undefined;
    let lastTarget: HunkBoundaryTarget | undefined;

    for (const part of parts)
    {
        const lines = splitLines(part.value);

        if (part.removed)
        {
            const placement = placementFor(document, currentLine);
            const output = presentationsFor(presentations, placement.lineNumber);
            const targetRows = placement.after ? output.after : output.before;

            for (const line of lines)
            {
                const target: HunkBoundaryTarget = {
                    kind: "synthetic",
                    rows: targetRows,
                    index: targetRows.length,
                };
                targetRows.push({ marker: "-", prefix: "|", content: line });
                firstTarget ??= target;
                lastTarget = target;
            }

            continue;
        }

        if (part.added)
        {
            for (const _line of lines)
            {
                const output = presentationsFor(presentations, currentLine);
                const target: HunkBoundaryTarget = { kind: "current", lineNumber: currentLine };
                output.added = true;
                firstTarget ??= target;
                lastTarget = target;
                currentLine++;
            }

            continue;
        }

        currentLine += lines.length;
    }

    if (firstTarget !== undefined && lastTarget !== undefined)
    {
        const annotation = `${group.selector} · ${group.state}`;

        if (sameTarget(firstTarget, lastTarget))
        {
            annotateTarget(presentations, firstTarget, `<!-- change: ${annotation} -->`);
        }
        else
        {
            annotateTarget(presentations, firstTarget, `<!-- change-begin: ${annotation} -->`);
            annotateTarget(presentations, lastTarget, `<!-- change-end: ${annotation} -->`);
        }
    }
}

function sameTarget(left: HunkBoundaryTarget, right: HunkBoundaryTarget): boolean
{
    return left.kind === "current" && right.kind === "current"
        ? left.lineNumber === right.lineNumber
        : left.kind === "synthetic" && right.kind === "synthetic"
        ? left.rows === right.rows && left.index === right.index
        : false;
}

function annotateTarget(
    presentations: Map<number, LineHunkPresentation>,
    target: HunkBoundaryTarget,
    annotation: string,
): void
{
    if (target.kind === "current")
    {
        presentationsFor(presentations, target.lineNumber).annotations.push(annotation);
        return;
    }

    const row = target.rows[target.index]!;
    target.rows[target.index] = { ...row, suffix: `${row.suffix ?? ""}  ${annotation}` };
}

function presentLine(line: TextLine, hunk: LineHunkPresentation | undefined): TextLine
{
    if (hunk === undefined)
    {
        return line;
    }

    const annotations = hunk.annotations.length === 0 ? "" : `  ${hunk.annotations.join(" ")}`;

    return {
        ...line,
        presentation: {
            ...line.presentation,
            ...(hunk.added ? { marker: "+" as const } : {}),
            before: [...(line.presentation?.before ?? []), ...hunk.before],
            after: [...hunk.after, ...(line.presentation?.after ?? [])],
            suffix: `${line.presentation?.suffix ?? ""}${annotations}`,
        },
    };
}

function presentationsFor(
    presentations: Map<number, LineHunkPresentation>,
    lineNumber: number,
): LineHunkPresentation
{
    const existing = presentations.get(lineNumber);

    if (existing !== undefined)
    {
        return existing;
    }

    const created: LineHunkPresentation = { before: [], after: [], annotations: [], added: false };
    presentations.set(lineNumber, created);
    return created;
}

function placementFor(document: TextDocument, requestedLine: number): { lineNumber: number; after: boolean; }
{
    if (requestedLine <= document.lines.length)
    {
        return { lineNumber: Math.max(1, requestedLine), after: false };
    }

    return { lineNumber: document.lines.length, after: true };
}

function splitLines(value: string): string[]
{
    if (value.length === 0)
    {
        return [];
    }

    const lines = value.split(/\r\n|\r|\n/u);

    if (lines.at(-1) === "")
    {
        lines.pop();
    }

    return lines;
}
