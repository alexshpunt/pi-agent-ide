import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  replaceAnchorSpan,
  selectionChanges,
  textSelections,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const replaceSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Source resource reference or file path. A typed SEARCH#... resource can select replacement ranges.",
      }),
    ),
    start: Type.Optional(
      Type.String({
        description:
          "Registered text anchor or unique exact text selecting the first span to replace",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description: "Registered text anchor or unique exact text selecting the last span",
      }),
    ),
    text: Type.String({ description: "Replacement text" }),
  },
  { additionalProperties: false },
);

interface ReplaceParameters {
  readonly path?: string;
  readonly start?: string;
  readonly end?: string;
  readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
  name: "replace",
  description:
    "Replace one span, a range between anchors, or every exact search match. A unique unregistered value is exact text.",

  promptSnippet: "Make precise file edits by replacing text using exact matches or anchors",
  parameters: replaceSchema,
  source: { field: "path", inherited: true },
  anchors: [
    {
      field: "start",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "end",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      optional: true,
    },
  ],
  pair: ["start", "end"],
  mutate: async (context, parameters: ReplaceParameters) => {
    const starts = await context.resolveAnchors("start");
    const selections = textSelections(starts, "start");
    if (parameters.end === undefined && selections !== undefined) {
      const changes = selectionChanges(context, selections, parameters.text);
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
        [
          span.source,
          { changes: [replaceAnchorSpan(context, span, parameters.text)], action: "edited" },
        ],
      ]),
    };
  },
};
