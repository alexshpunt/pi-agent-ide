import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import {
  resolveAnchorSpanRange,
  selectionChanges,
  textSelections,
} from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const deleteSchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection to remove, or a path without start to delete the file, directory or symlink itself. Omit to use the start anchor’s file.",
    ),
    ...sourceRangeProperties(),
  },
  { additionalProperties: false },
);
interface DeleteParameters {
  readonly path?: unknown;
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly start?: unknown;
  readonly end?: unknown;
}

export const deleteMutationTool: TextMutationToolRegistration<typeof deleteSchema> = {
  name: "delete",
  wholeFileOperation: "delete",
  description:
    "Use delete to remove text, delete a file or directory, or end a terminal or debugger session.",

  promptSnippet:
    "Delete files or selected text, terminate terminal or debugger sessions, or remove debugger breakpoints",
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

    const span = await resolveAnchorSpanRange(
      context,
      starts,
      "start",
      "end",
      parameters.end !== undefined,
    );
    return {
      edits: new Map([
        [
          span.source,
          { changes: [context.documentFor(span.source).delete(span)], action: "edited" },
        ],
      ]),
    };
  },
};
