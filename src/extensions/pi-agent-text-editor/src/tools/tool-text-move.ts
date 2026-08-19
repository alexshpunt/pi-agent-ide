import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { lineAnchor, selectionRange, singleSelection, textSelections } from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";
import type { TextChange } from "#src/core/text-change-engine.js";

export const moveSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Source file to move from" })),
    start: Type.String({ description: "Registered text anchor selecting the first line to move" }),
    end: Type.Optional(
        Type.String({ description: "Registered text anchor selecting the last line; defaults to start" }),
    ),
    target: Type.Optional(Type.String({ description: "Target file; defaults to the source file" })),
    targetStart: Type.String({
        description: "First target line; moved text is inserted after it when targetEnd is omitted",
    }),
    targetEnd: Type.Optional(Type.String({ description: "Last target line; the inclusive target range is replaced" })),
}, { additionalProperties: false });

interface MoveParams
{
    readonly path?: string;
    readonly start: string;
    readonly end?: string;
    readonly target?: string;
    readonly targetStart: string;
    readonly targetEnd?: string;
}

export const moveMutationTool: TextMutationToolRegistration<typeof moveSchema> = {
    name: "move",
    description: "Move selected lines and insert them after targetStart, or replace targetStart through targetEnd.",
    parameters: moveSchema,
    source: { field: "path", inherited: true, targets: [{ field: "target", fallbackTo: "path" }] },
    anchors: [
        { field: "start", sourceField: "path", kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND] },
        {
            field: "end",
            sourceField: "path",
            kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
            optional: true,
        },
        {
            field: "targetStart",
            sourceField: "target",
            kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
        },
        {
            field: "targetEnd",
            sourceField: "target",
            kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
            optional: true,
        },
    ],
    pair: ["start", "end"],
    mutate: async (context, params: MoveParams) =>
    {
        const starts = await context.resolveAnchors("start");
        const sourceSelections = textSelections(starts, "start");
        let source: string;
        let copied: string;
        let deletion: TextChange;

        if (sourceSelections === undefined)
        {
            source = context.sourceFor("path");
            const start = lineAnchor(starts, "start");
            const end = params.end === undefined
                ? start
                : lineAnchor(await context.resolveAnchors("end"), "end");
            const sourceDocument = context.documentFor(source);
            const sourceRange = sourceDocument.lineRange(start.lineNumber, end.lineNumber);
            copied = sourceDocument.text(sourceRange);
            deletion = sourceDocument.deleteLines(start.lineNumber, end.lineNumber);
        }
        else
        {
            if (params.end !== undefined)
            {
                throw new Error("end cannot be combined with a search selection.");
            }

            const selection = singleSelection(sourceSelections, "start");
            [source] = selection;
            const sourceRange = selectionRange(context, source, selection[1]);
            copied = context.documentFor(source).text(sourceRange);
            deletion = { ...sourceRange, insert: "" };
        }

        const targetStarts = await context.resolveAnchors("targetStart");
        const targetSelections = textSelections(targetStarts, "targetStart");
        let target: string;
        let targetChange: TextChange;

        if (targetSelections === undefined)
        {
            target = context.sourceFor("target");
            const targetDocument = context.documentFor(target);
            const targetStart = lineAnchor(targetStarts, "targetStart");
            const targetEnd = params.targetEnd === undefined
                ? undefined
                : lineAnchor(await context.resolveAnchors("targetEnd"), "targetEnd");
            targetChange = targetEnd === undefined
                ? targetDocument.insertAfterLine(targetStart.lineNumber, copied)
                : targetDocument.replaceLines(targetStart.lineNumber, targetEnd.lineNumber, copied);
        }
        else
        {
            if (params.targetEnd !== undefined)
            {
                throw new Error("targetEnd cannot be combined with a search selection.");
            }

            const selection = singleSelection(targetSelections, "targetStart");
            [target] = selection;
            const range = selection[1];
            const insertion = context.documentFor(target).range(
                range.end.lineNumber,
                range.end.column,
                range.end.lineNumber,
                range.end.column,
            );
            targetChange = { ...insertion, insert: copied };
        }

        if (source === target)
        {
            return {
                edits: new Map([[source, { changes: [deletion, targetChange], action: "edited" }]]),
            };
        }

        return {
            edits: new Map([
                [source, { changes: [deletion], action: "edited" }],
                [target, { changes: [targetChange], action: "edited" }],
            ]),
        };
    },
};
