import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import {
  insertSelectors,
  insertTextSelector,
  textSelectorAnchors,
} from "#src/api/text-selector-fields.ts";
import { refuseEndOfFileMarker } from "#src/tools/display-marker.ts";
import { anchorProperty } from "#src/tools/text-tool-schema-properties.ts";
import {
  insertionAfterAnchor,
  insertionBeforeAnchor,
  insertionChanges,
  textSelections,
} from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description: "Source selection or live resource.",
      }),
    ),
    after: anchorProperty(
      "Insert at the end of this selection. Do not combine with before. Omit both when path already selects text or a live resource.",
    ),
    before: anchorProperty(
      "Insert at the start of this selection. Do not combine with after. With a result as path, select inside its ranges.",
    ),
    text: Type.String({
      minLength: 1,
      description:
        "Non-empty text to insert. At a line edge, include a line break to insert separate lines; text with no line break goes at the selected boundary with default separation. Mid-line insertion keeps its character boundary.",
    }),
    separation: Type.Optional(
      Type.Union([Type.Literal("line"), Type.Literal("blank-line")], {
        description:
          "line (default) uses ordinary insertion; blank-line separates a paragraph at a line edge.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description:
    "Use insert to add text at a selection boundary without changing selected text, to send keys to a terminal session, or to control a debugger. At a line edge, use one leading or trailing line break in a text block as a separator and add more breaks for blank lines.",

  promptSnippet: "Insert file text, send terminal keys, or perform debugger actions",
  parameters: insertSchema,
  source: { field: "path", inherited: true },
  anchors: textSelectorAnchors("path", insertSelectors),
  validateInput: insertTextSelector,
  mutate: async (context, parameters) => {
    const field = insertTextSelector(parameters);
    const before = field === "before";
    if (parameters.text.length === 0) throw new Error("Insert text must not be empty.");
    refuseEndOfFileMarker(parameters.text);
    const anchors = await context.resolveAnchors(field);
    const selections = textSelections(anchors, field);

    if (selections !== undefined) {
      const changes = insertionChanges(
        context,
        selections,
        parameters.text,
        before,
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

    const insertion = before ? insertionBeforeAnchor : insertionAfterAnchor;
    const [source, change] = insertion(context, anchors, field, parameters.text, {
      separation: parameters.separation,
    });
    return {
      edits: new Map([[source, { changes: [change], action: "edited" }]]),
    };
  },
};
