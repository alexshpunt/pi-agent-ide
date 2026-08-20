import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { insertionChanges, lineAnchor, textSelections } from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "File path to edit" })),
    anchor: Type.String({
      description: "Registered text anchor; text is inserted after its resolved line",
    }),
    text: Type.String({ description: "Content to insert" }),
  },
  { additionalProperties: false },
);

interface InsertParameters {
  readonly path?: string;
  readonly anchor: string;
  readonly text: string;
}

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description: "Insert text after the line resolved by a registered text anchor.",
  parameters: insertSchema,
  source: { field: "path", inherited: true },
  anchors: [
    {
      field: "anchor",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
  ],
  mutate: async (context, parameters: InsertParameters) => {
    const anchors = await context.resolveAnchors("anchor");
    const selections = textSelections(anchors, "anchor");

    if (selections !== undefined) {
      const changes = insertionChanges(context, selections, parameters.text);
      return {
        edits: new Map(
          [...changes].map(([source, sourceChanges]) => [
            source,
            { changes: sourceChanges, action: "edited" as const },
          ]),
        ),
      };
    }

    const source = context.sourceFor("path");
    const anchor = lineAnchor(anchors, "anchor");
    return {
      edits: new Map([
        [
          source,
          {
            changes: [
              context.documentFor(source).insertAfterLine(anchor.lineNumber, parameters.text),
            ],
            action: "edited",
          },
        ],
      ]),
    };
  },
};
