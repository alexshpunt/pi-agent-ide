import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.js";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  transferText,
  deleteAnchorSpan,
  insertionAfterAnchor,
  replaceAnchorSpan,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";
import type { TextChange } from "#src/core/text-change-engine.js";

export const moveSchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source: a path, an unchanged Read/Search result or its UUID, or an array of them. A path without start moves the whole file, directory or symlink. Omit to use the file of the start anchor.",
    ),
    ...sourceRangeProperties(),
    ...targetProperties("Moving a directory replaces the target directory."),
  },
  { additionalProperties: false },
);
interface MoveParameters {
  readonly path?: unknown;
  readonly start?: string;
  readonly end?: string;
  readonly target?: unknown;
  readonly targetStart?: string;
  readonly targetEnd?: string;
}

export const moveMutationTool: TextMutationToolRegistration<typeof moveSchema> = {
  name: "move",
  wholeFileOperation: "move",
  description:
    "Use move to move or rename a file or directory, or to cut text from one place and put it in another.",

  promptSnippet: "Move filesystem objects or selected text",
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
      targetChange = replaceAnchorSpan(
        context,
        targetSpan,
        transferText(context, starts, ends, sourceSpan, targetSpan),
      );
    }

    if (sourceSpan.source === target && rangesTouch(deletion, targetChange)) {
      throw new Error("Move target must not overlap or touch its source range.");
    }

    if (sourceSpan.source === target) {
      return {
        edits: new Map([
          [target, { changes: [deletion, targetChange], action: "edited", resultChanges: [1] }],
        ]),
      };
    }

    return {
      edits: new Map([
        [sourceSpan.source, { changes: [deletion], action: "edited", resultChanges: [] }],
        [target, { changes: [targetChange], action: "edited" }],
      ]),
    };
  },
};

function rangesTouch(left: TextChange, right: TextChange): boolean {
  return left.from <= right.to && right.from <= left.to;
}
