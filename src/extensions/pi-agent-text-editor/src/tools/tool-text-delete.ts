import { Type } from "typebox";

import {
  resultSourceProperty,
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
    path: resultSourceProperty(
      "File path, shell:<session>, debug:<session>, debug:<session>/breakpoint/<id>, unchanged source result or its UUID, or an array of results. An ordinary file path without start/end deletes the file. A text result input removes only selected text and keeps the file, even for a whole-file selection. For Read results from symbol:<file>#<selector>, deletion removes only the declaration text; imports and references are unchanged. Omit start/end for result inputs. Omit path when a supplied text anchor identifies the file.",
    ),
    ...sourceRangeProperties({
      start:
        "Anchor or unique exact text locating the text to remove. Without end, exact text selects only that fragment; a line anchor selects its whole line. Omit when path already selects text.",
      end: "Anchor or unique exact text locating the last line to remove. With start, removes whole lines including both boundary lines, even for SEARCH :match anchors. Both boundaries must be unique, in one file, and in forward order. Mixed anchor types are allowed. Omit when start alone selects the intended text.",
    }),
  },
  { additionalProperties: false },
);
interface DeleteParameters {
  readonly path?: unknown;
  readonly start?: string;
  readonly end?: string;
}

export const deleteMutationTool: TextMutationToolRegistration<typeof deleteSchema> = {
  name: "delete",
  wholeFileOperation: "delete",
  description:
    "Use delete to remove selected text, permanently delete a regular file, terminate a terminal or debugger session, or remove a debugger breakpoint. Whole-file deletion rejects directories and symlinks.",

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

    const ends = parameters.end === undefined ? undefined : await context.resolveAnchors("end");
    const span = anchorSpanRange(context, starts, ends, "start", "end");
    return {
      edits: new Map([
        [span.source, { changes: [deleteAnchorSpan(context, span)], action: "edited" }],
      ]),
    };
  },
};
