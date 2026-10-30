import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  insertionAfterAnchor,
  insertionBeforeAnchor,
  insertionChanges,
  textSelections,
  targetText,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "File path, resource reference, unchanged Read/Search/edit result or its UUID; a result selects only its ranges. Omit to reuse the file of the anchor, the last read or the preceding edit.",
      }),
    ),
    anchor: Type.Optional(
      Type.String({
        description:
          "Line anchor or unique exact text. Insert at the selection boundary: whole lines include their own separator; partial or multiline exact matches keep character boundaries. Omit when path already selects text.",
      }),
    ),
    text: Type.String({
      minLength: 1,
      description:
        "Non-empty text to insert, using the target line-ending style. Whole-line selections add needed separators; exact fragments do not.",
    }),
    separation: Type.Optional(
      Type.Union([Type.Literal("line"), Type.Literal("blank-line")], {
        description: "line (default) or blank-line: add blank lines around the insertion.",
      }),
    ),
    before: Type.Optional(
      Type.Boolean({
        description:
          "true inserts at the start of the selection; default false inserts at its end.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface InsertParameters {
  readonly path?: string;
  readonly anchor?: string;
  readonly text: string;
  readonly separation?: "line" | "blank-line";
  readonly before?: boolean;
}

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description:
    "Use insert to add text at a selection boundary without changing selected text, to send keys to a terminal session, or to control a debugger.",

  promptSnippet: "Insert file text, send terminal keys, or perform debugger actions",
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
    if (parameters.text.length === 0) throw new Error("Insert text must not be empty.");
    const anchors = await context.resolveAnchors("anchor");
    const selections = textSelections(anchors, "anchor");

    if (selections !== undefined) {
      const changes = insertionChanges(
        context,
        selections,
        parameters.text,
        parameters.before,
        parameters.separation,
      );
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
    const [source, change] = insertion(
      context,
      anchors,
      "anchor",
      targetText(context, context.sourceFor("path"), parameters.text),
      parameters.separation,
    );
    return {
      edits: new Map([[source, { changes: [change], action: "edited" }]]),
    };
  },
};
