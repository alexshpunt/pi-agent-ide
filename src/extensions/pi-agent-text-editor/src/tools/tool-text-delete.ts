import { Type } from "typebox";

import {
  sourcePathProperty,
  sourceRangeProperties,
} from "#src/tools/text-tool-schema-properties.js";

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
    path: sourcePathProperty(
      "Source resource reference or file path. A returned SEARCH# reference can select deletion ranges.",
    ),
    ...sourceRangeProperties(),
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
  wholeFileOperation: "delete",
  description:
    "Use delete to permanently delete one regular file when path is supplied without text selectors, or to remove selected text. Whole-file deletion rejects directories and symlinks.",

  promptSnippet: "Delete regular files, or delete selected text using exact matches or anchors",
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
