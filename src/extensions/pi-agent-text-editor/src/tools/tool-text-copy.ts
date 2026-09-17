import { Type } from "typebox";

import {
  sourcePathProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.js";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  insertionAfterAnchor,
  replaceAnchorSpan,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const copySchema = Type.Object(
  {
    path: sourcePathProperty(
      "Source file path, or a returned SEARCH# reference selecting the text to copy",
    ),
    ...sourceRangeProperties(),
    ...targetProperties(),
  },
  { additionalProperties: false },
);
interface CopyParameters {
  readonly path?: string;
  readonly start?: string;
  readonly end?: string;
  readonly target?: string;
  readonly targetStart?: string;
  readonly targetEnd?: string;
}

export const copyMutationTool: TextMutationToolRegistration<typeof copySchema> = {
  name: "copy",
  wholeFileOperation: "copy",
  description:
    "Use copy to copy one regular file, or to duplicate selected text within or between files.",

  promptSnippet: "Copy regular files, or copy selected text within or between files",
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
      return { edits: new Map([[target, { changes: [change], action: "edited" }]]) };
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
          { changes: [replaceAnchorSpan(context, targetSpan, copied)], action: "edited" },
        ],
      ]),
    };
  },
};
