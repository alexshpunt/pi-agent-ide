import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  insertionAfterAnchor,
  insertionBeforeAnchor,
  insertionChanges,
  textSelections,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Source resource reference or file path. A typed SEARCH#... resource can select insertion positions.",
      }),
    ),
    anchor: Type.Optional(
      Type.String({
        description: "Registered text anchor or unique exact text span",
      }),
    ),
    text: Type.String({ description: "Content to insert" }),
    before: Type.Optional(
      Type.Boolean({ description: "Insert before the anchor instead of after it" }),
    ),
  },
  { additionalProperties: false },
);

interface InsertParameters {
  readonly path?: string;
  readonly anchor?: string;
  readonly text: string;
  readonly before?: boolean;
}

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description: "Insert text before or after a registered anchor or one unique exact text span.",

  promptSnippet:
    "Make precise file edits by inserting text before or after exact matches or anchors",
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
      const changes = insertionChanges(context, selections, parameters.text, parameters.before);
      return {
        edits: new Map(
          [...changes].map(([source, sourceChanges]) => [
            source,
            { changes: sourceChanges, action: "edited" as const },
          ]),
        ),
      };
    }

    const insertion = parameters.before === true ? insertionBeforeAnchor : insertionAfterAnchor;
    const [source, change] = insertion(context, anchors, "anchor", parameters.text);
    return {
      edits: new Map([[source, { changes: [change], action: "edited" }]]),
    };
  },
};
