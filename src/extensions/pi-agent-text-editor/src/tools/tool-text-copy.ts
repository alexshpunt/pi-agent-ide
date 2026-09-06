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
        description:
          "Source resource reference or file path; a typed resource may select one source span",
      }),
    ),
    start: Type.Optional(
      Type.String({
        description: "Registered text anchor or unique exact text at the source start",
      }),
    ),
    end: Type.Optional(Type.String({ description: "Source end anchor; defaults to start" })),
    target: Type.Optional(
      Type.String({
        description:
          "Target resource reference or file path; a typed resource may select the destination; defaults to the source",
      }),
    ),
    targetStart: Type.Optional(
      Type.String({
        description: "Target anchor; copied text is inserted after it when targetEnd is omitted",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({ description: "Target end anchor; the natural target range is replaced" }),
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
  description: "Copy one span or an anchor range, then insert it or replace a target range.",

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
