import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import { anchorProperty } from "#src/tools/text-tool-schema-properties.ts";
import {
  insertionAfterAnchor,
  insertionBeforeAnchor,
  insertionChanges,
  textSelections,
  targetText,
} from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description: "Source selection or live resource.",
      }),
    ),
    anchor: anchorProperty(
      "Selection whose start or end receives the text. Omit when path already selects text. With a result as path, it selects inside the result's ranges.",
    ),
    text: Type.String({
      minLength: 1,
      description:
        "Non-empty text to insert. A selection of whole lines, including exact text of a complete line, puts the text on its own line and adds needed line breaks; a partial-line selection inserts the text exactly.",
    }),
    separation: Type.Optional(
      Type.Union([Type.Literal("line"), Type.Literal("blank-line")], {
        description:
          "line (default) keeps the line handling above; blank-line puts the text in its own paragraph, with blank lines around it.",
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
  readonly path?: unknown;
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly anchor?: unknown;
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
