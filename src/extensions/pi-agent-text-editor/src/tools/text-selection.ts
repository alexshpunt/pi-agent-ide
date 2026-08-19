import { TextSelectionAnchor, type TextSelectionRange } from "#src/api/text-selection-anchor.js";

import type { TextMutationContext } from "#src/api/mutation-tool.js";
import type { TextAnchor } from "pi-agent-text";

export function textSelections(
    anchors: ReadonlyMap<string, TextAnchor>,
    field: string,
): ReadonlyMap<string, TextSelectionAnchor> | undefined
{
    const values = [...anchors.values()];

    if (!values.some((anchor) => TextSelectionAnchor.is(anchor)))
    {
        return undefined;
    }

    if (!values.every((anchor) => TextSelectionAnchor.is(anchor)))
    {
        throw new Error(`Anchor ${field} resolved to incompatible selection types.`);
    }

    return anchors as ReadonlyMap<string, TextSelectionAnchor>;
}

export function lineAnchor(anchors: ReadonlyMap<string, TextAnchor>, field: string): TextAnchor
{
    if (textSelections(anchors, field) !== undefined)
    {
        throw new Error(`Anchor ${field} cannot use a search selection as a line endpoint.`);
    }

    if (anchors.size !== 1)
    {
        throw new Error(`Anchor ${field} must resolve in one resource.`);
    }

    return anchors.values().next().value!;
}

export function selectionChanges(
    context: TextMutationContext,
    selections: ReadonlyMap<string, TextSelectionAnchor>,
    insert: string,
): ReadonlyMap<string, readonly { readonly from: number; readonly to: number; readonly insert: string; }[]>
{
    return new Map([...selections].map(([source, anchor]) => [
        source,
        anchor.ranges.map((range) => ({ ...selectionRange(context, source, range), insert })),
    ]));
}

export function insertionChanges(
    context: TextMutationContext,
    selections: ReadonlyMap<string, TextSelectionAnchor>,
    insert: string,
): ReadonlyMap<string, readonly { readonly from: number; readonly to: number; readonly insert: string; }[]>
{
    return new Map([...selections].map(([source, anchor]) => [
        source,
        anchor.ranges.map((range) =>
        {
            const at = context.documentFor(source).range(
                range.end.lineNumber,
                range.end.column,
                range.end.lineNumber,
                range.end.column,
            );
            return { ...at, insert };
        }),
    ]));
}

export function singleSelection(
    selections: ReadonlyMap<string, TextSelectionAnchor>,
    field: string,
): readonly [string, TextSelectionRange]
{
    if (selections.size !== 1)
    {
        throw new Error(`Anchor ${field} must select one resource for this operation.`);
    }

    const [source, anchor] = selections.entries().next().value!;

    if (anchor.ranges.length !== 1)
    {
        throw new Error(`Anchor ${field} must select one match for this operation.`);
    }

    return [source, anchor.ranges[0]!];
}

export function selectionRange(
    context: TextMutationContext,
    source: string,
    range: TextSelectionRange,
): { readonly from: number; readonly to: number; }
{
    return context.documentFor(source).range(
        range.start.lineNumber,
        range.start.column,
        range.end.lineNumber,
        range.end.column,
    );
}
