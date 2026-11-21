import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";
import { PRESENTED_LINE_ANCHOR_PATTERN, isLineAnchor } from "pi-agent-text";

import { resolvedTextAnchorType } from "#src/core/text-anchor-registry.ts";
import { refuseEndOfFileMarker } from "#src/tools/display-marker.ts";

import { anchorProperty, sourceRangeProperties } from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import {
  resolveAnchorSpanRange,
  selectionChanges,
  textSelections,
} from "#src/tools/text-selection.ts";

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
    ...sourceRangeProperties({
      start:
        "Include the opening match; omit after. Omit start when path selects the intended text.",
      end: "Include the first match after the opening selector at the end of the range; omit before.",
    }),
    after: anchorProperty(
      "Begin after a unique opening match (on the next line at a line edge); omit start and pass end or before.",
    ),
    before: anchorProperty(
      "Stop before the first following match (at the previous line’s end at a line edge); omit end and pass start or after.",
    ),
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
  readonly after?: unknown;
  readonly before?: unknown;
  readonly end?: unknown;
  readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
  name: "replace",
  description:
    "Use replace to change text selected by a result, a single start, or a pair of range boundaries.",

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
      field: "after",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "before",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      pairedEnd: true,
    },
    {
      field: "end",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      optional: true,
    },
  ],
  pair: ["start", "end"],
  validateInput: validateBoundaries,
  mutate: async (context, parameters: ReplaceParameters) => {
    validateBoundaries(parameters);
    refuseEndOfFileMarker(parameters.text);
    const startField = parameters.after === undefined ? "start" : "after";
    const endField = parameters.before === undefined ? "end" : "before";
    const hasEnd = parameters[endField] !== undefined;
    const starts = await context.resolveAnchors(startField);
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
    const selections = textSelections(starts, startField);
    if (!hasEnd && selections !== undefined) {
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

    const span = await resolveAnchorSpanRange(context, starts, startField, endField, hasEnd, {
      excludeStart: startField === "after",
      excludeEnd: endField === "before",
    });
    const document = context.documentFor(span.source);
    const change =
      span.insertion !== undefined && parameters.text !== ""
        ? document.insert(span, parameters.text, {
            before: true,
            linewise: span.insertion === "line",
          })
        : document.replace(span, parameters.text);
    refuseIdenticalReplacement(context, [{ source: span.source, ...change }]);
    return {
      edits: new Map([[span.source, { changes: [change], action: "edited" }]]),
    };
  },
};

function validateBoundaries(input: Omit<ReplaceParameters, "text">): void {
  if (input.start !== undefined && input.after !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass start or after, not both: start includes the opening match and after excludes it.",
    );
  if (input.end !== undefined && input.before !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass end or before, not both: end includes the closing match and before excludes it.",
    );
  if (input.after !== undefined && input.end === undefined && input.before === undefined)
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      "Pass end to include the closing match or before to exclude it when using after.",
    );
  if (input.before !== undefined && input.start === undefined && input.after === undefined)
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      "Pass start to include the opening match or after to exclude it when using before.",
    );
}

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
