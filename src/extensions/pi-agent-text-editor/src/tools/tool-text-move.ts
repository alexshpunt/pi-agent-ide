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
        description: "Target anchor; moved text is inserted after it when targetEnd is omitted",
      }),
    ),
    targetEnd: Type.Optional(
      Type.String({ description: "Target end anchor; the natural target range is replaced" }),
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
  description: "Move one span or an anchor range, then insert it or replace a target range.",

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
