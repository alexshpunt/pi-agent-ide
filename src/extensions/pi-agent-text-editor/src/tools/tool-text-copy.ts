import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import { resolveAnchorSpanRange, insertionAfterAnchor } from "#src/tools/text-selection.ts";

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
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly start?: unknown;
  readonly end?: unknown;
  readonly target?: unknown;
  readonly targetStart?: unknown;
  readonly targetEnd?: unknown;
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
    const sourceSpan = await resolveAnchorSpanRange(
      context,
      starts,
      "start",
      "end",
      parameters.end !== undefined,
    );
    const copied = context.documentFor(sourceSpan.source).transfer(sourceSpan);

    const targetStarts = await context.resolveAnchors("targetStart");
    if (parameters.targetEnd === undefined) {
      const [target, change] = insertionAfterAnchor(context, targetStarts, "targetStart", copied);
      return {
        edits: new Map([
          [target, { changes: [{ ...change, selectorFields: ["targetStart"] }], action: "edited" }],
        ]),
      };
    }

    const targetSpan = await resolveAnchorSpanRange(
      context,
      targetStarts,
      "targetStart",
      "targetEnd",
      true,
    );
    return {
      edits: new Map([
        [
          targetSpan.source,
          {
            changes: [
              {
                ...context.documentFor(targetSpan.source).replace(targetSpan, copied),
                selectorFields: ["targetStart", "targetEnd"],
              },
            ],
            action: "edited",
          },
        ],
      ]),
    };
  },
};
