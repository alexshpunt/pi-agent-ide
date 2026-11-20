import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import { resolveAnchorSpanRange, insertionAfterAnchor } from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";
import type { TextChange } from "#src/core/text-change-engine.ts";

export const moveSchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection, or a path without start to move the whole file, directory or symlink.",
    ),
    ...sourceRangeProperties(),
    ...targetProperties("Moving a directory replaces the target directory."),
  },
  { additionalProperties: false },
);
interface MoveParameters {
  readonly path?: unknown;
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly start?: unknown;
  readonly end?: unknown;
  readonly target?: unknown;
  readonly targetStart?: unknown;
  readonly targetEnd?: unknown;
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
    const sourceSpan = await resolveAnchorSpanRange(
      context,
      starts,
      "start",
      "end",
      parameters.end !== undefined,
    );
    const copied = context.documentFor(sourceSpan.source).transfer(sourceSpan);
    const deletion = {
      ...context.documentFor(sourceSpan.source).delete(sourceSpan),
      selectorFields: parameters.end === undefined ? ["start"] : ["start", "end"],
    };

    const targetStarts = await context.resolveAnchors("targetStart");
    let target: string;
    let targetChange: TextChange;
    if (parameters.targetEnd === undefined) {
      [target, targetChange] = insertionAfterAnchor(context, targetStarts, "targetStart", copied);
    } else {
      const targetSpan = await resolveAnchorSpanRange(
        context,
        targetStarts,
        "targetStart",
        "targetEnd",
        true,
      );
      target = targetSpan.source;
      targetChange = context.documentFor(target).replace(targetSpan, copied);
    }

    const destination = {
      ...targetChange,
      selectorFields:
        parameters.targetEnd === undefined ? ["targetStart"] : ["targetStart", "targetEnd"],
    };

    if (sourceSpan.source === target && rangesTouch(deletion, destination)) {
      throw new Error("Move target must not overlap or touch its source range.");
    }

    if (sourceSpan.source === target) {
      return {
        edits: new Map([
          [target, { changes: [deletion, destination], action: "edited", resultChanges: [1] }],
        ]),
      };
    }

    return {
      edits: new Map([
        [sourceSpan.source, { changes: [deletion], action: "edited", resultChanges: [] }],
        [target, { changes: [destination], action: "edited" }],
      ]),
    };
  },
};

function rangesTouch(left: TextChange, right: TextChange): boolean {
  return left.from <= right.to && right.from <= left.to;
}
