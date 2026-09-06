import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  deleteAnchorSpan,
  selectionChanges,
  textSelections,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const deleteSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Source resource reference or file path. A typed SEARCH#... resource can select deletion ranges.",
      }),
    ),
    start: Type.Optional(
      Type.String({
        description: "Registered text anchor or unique exact text selecting the first span",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description: "Registered text anchor or unique exact text selecting the last span",
      }),
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
  description: "Delete one selected span or the natural range between two anchors.",

  promptSnippet: "Make precise file edits by deleting text using exact matches or anchors",
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
    const starts = await context.resolveAnchors("start");
    const selections = textSelections(starts, "start");
    if (parameters.end === undefined && selections !== undefined) {
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

    const ends = parameters.end === undefined ? undefined : await context.resolveAnchors("end");
    const span = anchorSpanRange(context, starts, ends, "start", "end");
    return {
      edits: new Map([
        [span.source, { changes: [deleteAnchorSpan(context, span)], action: "edited" }],
      ]),
    };
  },
};
