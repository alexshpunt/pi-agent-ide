import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import { sourceRangeProperties } from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import {
  anchorSpanRange,
  replaceAnchorSpan,
  selectionChanges,
  textSelections,
} from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const replaceSchema = Type.Object(
  {
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description: "Source selection. Omit to reuse the anchor’s file or the last source.",
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
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly start?: unknown;
  readonly end?: unknown;
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
