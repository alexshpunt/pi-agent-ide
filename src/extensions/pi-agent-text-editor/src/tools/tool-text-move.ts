import { Type } from "typebox";

import {
  sourcePathProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.js";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  deleteAnchorSpan,
  insertionAfterAnchor,
  replaceAnchorSpan,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";
import type { TextChange } from "#src/core/text-change-engine.js";

export const moveSchema = Type.Object(
  {
    path: sourcePathProperty(
      "Source file path, or a returned SEARCH# reference selecting the text to move",
    ),
    ...sourceRangeProperties(),
    ...targetProperties(),
  },
  { additionalProperties: false },
);
interface MoveParameters {
  readonly path?: string;
  readonly start?: string;
  readonly end?: string;
  readonly target?: string;
  readonly targetStart?: string;
  readonly targetEnd?: string;
}

export const moveMutationTool: TextMutationToolRegistration<typeof moveSchema> = {
  name: "move",
  wholeFileOperation: "move",
  description:
    "Use move to move or rename one regular file, or to relocate selected text within or between files.",

  promptSnippet: "Move or rename regular files, or move selected text within or between files",
  parameters: moveSchema,
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
  mutate: async (context, parameters: MoveParameters) => {
    const starts = await context.resolveAnchors("start");
    const ends = parameters.end === undefined ? undefined : await context.resolveAnchors("end");
    const sourceSpan = anchorSpanRange(context, starts, ends, "start", "end");
    const copied = context.documentFor(sourceSpan.source).text(sourceSpan);
    const deletion = deleteAnchorSpan(context, sourceSpan);

    const targetStarts = await context.resolveAnchors("targetStart");
    let target: string;
    let targetChange: TextChange;
    if (parameters.targetEnd === undefined) {
      [target, targetChange] = insertionAfterAnchor(context, targetStarts, "targetStart", copied);
    } else {
      const targetEnds = await context.resolveAnchors("targetEnd");
      const targetSpan = anchorSpanRange(
        context,
        targetStarts,
        targetEnds,
        "targetStart",
        "targetEnd",
      );
      target = targetSpan.source;
      targetChange = replaceAnchorSpan(context, targetSpan, copied);
    }

    if (sourceSpan.source === target && rangesTouch(deletion, targetChange)) {
      throw new Error("Move target must not overlap or touch its source range.");
    }

    if (sourceSpan.source === target) {
      return {
        edits: new Map([[target, { changes: [deletion, targetChange], action: "edited" }]]),
      };
    }

    return {
      edits: new Map([
        [sourceSpan.source, { changes: [deletion], action: "edited" }],
        [target, { changes: [targetChange], action: "edited" }],
      ]),
    };
  },
};

function rangesTouch(left: TextChange, right: TextChange): boolean {
  return left.from <= right.to && right.from <= left.to;
}
