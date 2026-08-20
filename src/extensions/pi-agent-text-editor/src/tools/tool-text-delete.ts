import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import { lineAnchor, selectionChanges, textSelections } from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const deleteSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "File path to edit" })),
    start: Type.Optional(
      Type.String({ description: "Registered text anchor selecting the first line to delete" }),
    ),
    end: Type.Optional(
      Type.String({ description: "Registered text anchor selecting the last line to delete" }),
    ),
  },
  { additionalProperties: false },
);

interface DeleteParameters {
  readonly path?: string;
  readonly start?: string;
  readonly end?: string;
}

export const deleteMutationTool: TextMutationToolRegistration<typeof deleteSchema> = {
  name: "delete",
  description: "Delete lines selected by registered text anchors.",
  parameters: deleteSchema,
  source: { field: "path", inherited: true },
  anchors: [
    {
      field: "start",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      optional: true,
    },
    {
      field: "end",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      optional: true,
    },
  ],
  pair: ["start", "end"],
  mutate: async (context, parameters: DeleteParameters) => {
    if (parameters.start === undefined) {
      throw new Error("start anchor is required.");
    }

    const starts = await context.resolveAnchors("start");
    const selections = textSelections(starts, "start");

    if (selections !== undefined) {
      if (parameters.end !== undefined) {
        throw new Error("end cannot be combined with a search selection.");
      }

      const changes = selectionChanges(context, selections, "");
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
    const start = lineAnchor(starts, "start");
    const end =
      parameters.end === undefined ? start : lineAnchor(await context.resolveAnchors("end"), "end");
    return {
      edits: new Map([
        [
          source,
          {
            changes: [context.documentFor(source).deleteLines(start.lineNumber, end.lineNumber)],
            action: "edited",
          },
        ],
      ]),
    };
  },
};
