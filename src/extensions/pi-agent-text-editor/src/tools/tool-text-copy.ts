import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import { anchorSpanRange, insertionAfterAnchor } from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const copySchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection, or a path without start to copy the whole file, directory or symlink. Omit to use the start anchor’s file.",
    ),
    ...sourceRangeProperties(),
    ...targetProperties(
      "Copying a directory merges into the target and keeps files that exist only there.",
    ),
  },
  { additionalProperties: false },
);
interface CopyParameters {
  readonly path?: unknown;
  readonly start?: string;
  readonly end?: string;
  readonly target?: unknown;
  readonly targetStart?: string;
  readonly targetEnd?: string;
}

export const copyMutationTool: TextMutationToolRegistration<typeof copySchema> = {
  name: "copy",
  wholeFileOperation: "copy",
  description: "Use copy to copy a file or directory, or to duplicate text in another place.",

  promptSnippet: "Copy filesystem objects or selected text",
  parameters: copySchema,
  source: { field: "path", inherited: true, targets: [{ field: "target", fallbackTo: "path" }] },
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
    {
      field: "targetStart",
      sourceField: "target",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "targetEnd",
      sourceField: "target",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      optional: true,
    },
  ],
  pair: ["start", "end"],
  mutate: async (context, parameters: CopyParameters) => {
    const starts = await context.resolveAnchors("start");
    const ends = parameters.end === undefined ? undefined : await context.resolveAnchors("end");
    const sourceSpan = anchorSpanRange(context, starts, ends, "start", "end");
    const copied = context.documentFor(sourceSpan.source).text(sourceSpan);

    const targetStarts = await context.resolveAnchors("targetStart");
    if (parameters.targetEnd === undefined) {
      const [target, change] = insertionAfterAnchor(context, targetStarts, "targetStart", copied);
      return {
        edits: new Map([[target, { changes: [change], action: "edited" }]]),
      };
    }

    const targetEnds = await context.resolveAnchors("targetEnd");
    const targetSpan = anchorSpanRange(
      context,
      targetStarts,
      targetEnds,
      "targetStart",
      "targetEnd",
    );
    return {
      edits: new Map([
        [
          targetSpan.source,
          {
            changes: [{ from: targetSpan.from, to: targetSpan.to, insert: copied }],
            action: "edited",
          },
        ],
      ]),
    };
  },
};
