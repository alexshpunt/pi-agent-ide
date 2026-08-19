import { Type } from "typebox";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const writeSchema = Type.Object({
    path: Type.String({ description: "Path to the file to create or overwrite" }),
    content: Type.String({ description: "File content" }),
}, { additionalProperties: false });

interface WriteParams
{
    readonly path: string;
    readonly content: string;
}

export const writeMutationTool: TextMutationToolRegistration<typeof writeSchema> = {
    name: "write",
    description: "Create a file or overwrite its complete text.",
    parameters: writeSchema,
    source: { field: "path" },
    anchors: [],
    mutate: (context, params: WriteParams) => ({
        edits: new Map([[params.path, {
            changes: [context.sourceDocument.replaceAll(params.content)],
            action: "overwritten",
        }]]),
    }),
};
