import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { lineAnchor, selectionChanges, textSelections } from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const replaceSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "File path to edit" })),
    start: Type.String({ description: "Registered text anchor selecting the first line to replace" }),
    end: Type.Optional(Type.String({ description: "Registered text anchor selecting the last line to replace" })),
    text: Type.String({ description: "Replacement text" }),
}, { additionalProperties: false });

interface ReplaceParams
{
    readonly path?: string;
    readonly start: string;
    readonly end?: string;
    readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
    name: "replace",
    description:
        "Replace lines or every exact search match selected by registered text anchors. For the same replacement at all matches, pass a SEARCH#HASH:all anchor from search as start.",
    parameters: replaceSchema,
    source: { field: "path", inherited: true },
    anchors: [
        { field: "start", sourceField: "path", kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND] },
        {
            field: "end",
            sourceField: "path",
            kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
            optional: true,
        },
    ],
    pair: ["start", "end"],
    mutate: async (context, params: ReplaceParams) =>
    {
        const starts = await context.resolveAnchors("start");
        const selections = textSelections(starts, "start");

        if (selections !== undefined)
        {
            if (params.end !== undefined)
            {
                throw new Error("end cannot be combined with a search selection.");
            }

            const changes = selectionChanges(context, selections, params.text);
            return {
                edits: new Map([...changes].map(([source, sourceChanges]) => [
                    source,
                    { changes: sourceChanges, action: "edited" as const },
                ])),
            };
        }

        const source = context.sourceFor("path");
        const start = lineAnchor(starts, "start");
        const end = params.end === undefined
            ? start
            : lineAnchor(await context.resolveAnchors("end"), "end");
        return {
            edits: new Map([[source, {
                changes: [context.documentFor(source).replaceLines(start.lineNumber, end.lineNumber, params.text)],
                action: "edited",
            }]]),
        };
    },
};
