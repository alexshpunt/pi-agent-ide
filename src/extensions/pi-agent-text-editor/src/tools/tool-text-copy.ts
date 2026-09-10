import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  anchorSpanRange,
  insertionAfterAnchor,
  replaceAnchorSpan,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const copySchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description: "Source file path, or a returned SEARCH# reference selecting the text to copy",
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
  description:
    "Use copy to duplicate existing text within or between files while keeping the source. Select the source and destination without reproducing the text in your call. The copy is inserted at the destination or replaces a destination range.",

  promptSnippet:
    "Make precise file edits by copying text within or between files using exact matches or anchors",
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
