import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";
import { PRESENTED_LINE_ANCHOR_PATTERN, isLineAnchor } from "pi-agent-text";

import { resolvedTextAnchorType } from "#src/core/text-anchor-registry.ts";
import { refuseEndOfFileMarker } from "#src/tools/display-marker.ts";

import { sourceRangeProperties } from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import { anchorSpanRange, selectionChanges, textSelections } from "#src/tools/text-selection.ts";

import {
  TextMutationInputError,
  type TextMutationContext,
  type TextMutationToolRegistration,
} from "#src/api/mutation-tool.ts";

export const replaceSchema = Type.Object(
  {
    path: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description: "Source selection. Omit to reuse the anchor’s file or the last source.",
      }),
    ),
    ...sourceRangeProperties(),
    text: Type.String({
      description:
        "Replacement for each selected range; empty text deletes it. Over whole lines, the last line keeps its original ending. Use a single line break to leave one empty line. Outside the part you change, look-alike characters (special spaces, smart quotes, dashes) keep the original; send only look-alikes to normalize them.",
    }),
  },
  { additionalProperties: false },
);
interface ReplaceParameters {
  readonly path?: unknown;
  /** Selectors hold anchor text: the IDE replaces a value with an id by its reference. */
  readonly start?: unknown;
  readonly end?: unknown;
  readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
  name: "replace",
  description: "Use replace to change selected text.",

  promptSnippet: "Make precise file edits by replacing text using exact matches or anchors",
  parameters: replaceSchema,
  source: { field: "path", inherited: true },
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
  ],
  pair: ["start", "end"],
  mutate: async (context, parameters: ReplaceParameters) => {
    refuseEndOfFileMarker(parameters.text);
    const starts = await context.resolveAnchors("start");
    const copiedAnchor = PRESENTED_LINE_ANCHOR_PATTERN.exec(parameters.text)?.[1];
    if (
      copiedAnchor !== undefined &&
      [...starts.values()].some(
        (anchor) =>
          resolvedTextAnchorType(anchor) === "major" &&
          isLineAnchor(anchor.value) &&
          anchor.value === copiedAnchor,
      )
    ) {
      throw new TextMutationInputError(
        "COPIED_LINE_ANCHOR",
        `Replacement text starts with the copied display prefix "${copiedAnchor}|". Nothing was changed. Remove that prefix from text and retry with only the replacement content. To write the prefix literally, select the text through a Search result or longer exact text.`,
      );
    }
    const selections = textSelections(starts, "start");
    if (parameters.end === undefined && selections !== undefined) {
      const changes = selectionChanges(context, selections, parameters.text);
      refuseIdenticalReplacement(
        context,
        [...changes].flatMap(([source, sourceChanges]) =>
          sourceChanges.map((change) => ({ source, ...change })),
        ),
      );
      return {
        edits: new Map(
          [...changes].map(([source, sourceChanges]) => [
            source,
            { changes: sourceChanges, action: "edited" as const },
          ]),
        ),
      };
    }

    const ends = parameters.end === undefined ? undefined : await context.resolveAnchors("end");
    const span = await anchorSpanRange(context, starts, ends, "start", "end");
    const change = context.documentFor(span.source).replace(span, parameters.text);
    refuseIdenticalReplacement(context, [{ source: span.source, ...change }]);
    return {
      edits: new Map([[span.source, { changes: [change], action: "edited" }]]),
    };
  },
};

/**
 * Refuses a call whose replacement equals every selected target byte for byte. When only some
 * targets already hold the text, the others are edited as usual.
 */
function refuseIdenticalReplacement(
  context: TextMutationContext,
  targets: readonly {
    readonly source: string;
    readonly from: number;
    readonly to: number;
    readonly insert: string;
  }[],
): void {
  if (targets.length === 0) return;
  if (targets.some((target) => context.documentFor(target.source).text(target) !== target.insert))
    return;
  throw new TextMutationInputError(
    "REPLACEMENT_IDENTICAL",
    "The replacement text is identical to the selected text, so nothing would change. replace writes text in place of the selection: send the changed text.",
  );
}
