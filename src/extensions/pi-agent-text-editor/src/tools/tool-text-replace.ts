import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import { sourceRangeProperties } from "#src/tools/text-tool-schema-properties.js";

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
      Type.Union(resultInputSchema.anyOf, {
        description:
          "File path, SEARCH# reference, unchanged Read/Search/edit result or its UUID, or an array of them; a result selects only its ranges. Omit to reuse the file of the anchor, the last read or the preceding edit.",
      }),
    ),
    ...sourceRangeProperties(),
    text: Type.String({
      description: "Replacement for each selected range; empty text deletes it.",
    }),
  },
  { additionalProperties: false },
);
interface ReplaceParameters {
  readonly path?: unknown;
  readonly start?: string;
  readonly end?: string;
  readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
  name: "replace",
  description: "Use replace to change selected text.",

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
