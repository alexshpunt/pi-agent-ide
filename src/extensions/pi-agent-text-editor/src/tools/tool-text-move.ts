import { Type } from "typebox";

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
    path: Type.Optional(
      Type.String({
        description: "Source file path, or a returned SEARCH# reference selecting the text to move",
      }),
    ),
    start: Type.Optional(
      Type.String({
        description:
          "Anchor or unique exact text. Alone, selects that fragment; a line anchor selects only its line. Omit when path already selects text through a supported resource reference. With end, selects a whole-line range.",
      }),
    ),
    end: Type.Optional(
      Type.String({
        description:
          "Optional anchor or unique exact text. Range includes start's first line through end's last line, even for SEARCH :match. Mixed types allowed; boundaries must be unique, in one file, and forward-ordered. Omit when start already selects the intended content; do not repeat start. The end line is included, not a stopping point before it.",
      }),
    ),
    target: Type.Optional(
      Type.String({
        description:
          "Target resource reference or file path; a returned SEARCH# reference may select the destination; defaults to the source",
      }),
    ),
    targetStart: Type.Optional(
      Type.String({
        description:
          "Registered anchor or unique exact text in the destination. Required unless target already selects one destination range. Without targetEnd, inserts after the last containing line, keeping the selected text. With targetEnd, replacement starts at the first containing line. SEARCH :match also uses these line boundaries.",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({
        description:
          "Optional inclusive destination end. Replaces whole lines through the last line containing this anchor, including SEARCH :match. May differ in type from targetStart; both must resolve uniquely in the target file and in forward order. Omit to insert after targetStart instead.",
      }),
    ),
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
  description:
    "Use move to relocate existing text within or between files. Select the source and destination without reproducing the text in your call. The selected text is removed from the source and inserted at the destination, or replaces a destination range.",

  promptSnippet:
    "Make precise file edits by moving text within or between files using exact matches or anchors",
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
