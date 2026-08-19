import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { lineAnchor, selectionRange, singleSelection, textSelections } from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const copySchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Source file to copy from" })),
    start: Type.String({ description: "Registered text anchor selecting the first line to copy" }),
    end: Type.Optional(
        Type.String({ description: "Registered text anchor selecting the last line; defaults to start" }),
    ),
    target: Type.Optional(Type.String({ description: "Target file; defaults to the source file" })),
    targetStart: Type.String({
        description: "First target line; copied text is inserted after it when targetEnd is omitted",
    }),
    targetEnd: Type.Optional(Type.String({ description: "Last target line; the inclusive target range is replaced" })),
}, { additionalProperties: false });

interface CopyParams
{
    readonly path?: string;
    readonly start: string;
    readonly end?: string;
    readonly target?: string;
    readonly targetStart: string;
    readonly targetEnd?: string;
}

export const copyMutationTool: TextMutationToolRegistration<typeof copySchema> = {
    name: "copy",
    description: "Copy selected lines and insert them after targetStart, or replace targetStart through targetEnd.",
    parameters: copySchema,
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
    mutate: async (context, params: CopyParams) =>
    {
        const starts = await context.resolveAnchors("start");
        const sourceSelections = textSelections(starts, "start");
        let copied: string;

        if (sourceSelections === undefined)
        {
            const source = context.sourceFor("path");
            const start = lineAnchor(starts, "start");
            const end = params.end === undefined
                ? start
                : lineAnchor(await context.resolveAnchors("end"), "end");
            const sourceDocument = context.documentFor(source);
            copied = sourceDocument.text(sourceDocument.lineRange(start.lineNumber, end.lineNumber));
        }
        else
        {
            if (params.end !== undefined)
            {
                throw new Error("end cannot be combined with a search selection.");
            }

            const [source, range] = singleSelection(sourceSelections, "start");
            copied = context.documentFor(source).text(selectionRange(context, source, range));
        }

        const targetStarts = await context.resolveAnchors("targetStart");
        const targetSelections = textSelections(targetStarts, "targetStart");

        if (targetSelections !== undefined)
        {
            if (params.targetEnd !== undefined)
            {
                throw new Error("targetEnd cannot be combined with a search selection.");
            }

            const [target, range] = singleSelection(targetSelections, "targetStart");
            const targetDocument = context.documentFor(target);
            const insertion = targetDocument.range(
                range.end.lineNumber,
                range.end.column,
                range.end.lineNumber,
                range.end.column,
            );
            return {
                edits: new Map([[target, { changes: [{ ...insertion, insert: copied }], action: "edited" }]]),
            };
        }

        const target = context.sourceFor("target");
        const targetDocument = context.documentFor(target);
        const targetStart = lineAnchor(targetStarts, "targetStart");
        const targetEnd = params.targetEnd === undefined
            ? undefined
            : lineAnchor(await context.resolveAnchors("targetEnd"), "targetEnd");
        const change = targetEnd === undefined
            ? targetDocument.insertAfterLine(targetStart.lineNumber, copied)
            : targetDocument.replaceLines(targetStart.lineNumber, targetEnd.lineNumber, copied);

        return {
            edits: new Map([[target, { changes: [change], action: "edited" }]]),
        };
    },
};
