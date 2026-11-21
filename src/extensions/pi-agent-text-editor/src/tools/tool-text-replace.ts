import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";
import { PRESENTED_LINE_ANCHOR_PATTERN, isLineAnchor } from "pi-agent-text";

import { resolvedTextAnchorType } from "#src/core/text-anchor-registry.ts";
import { refuseEndOfFileMarker } from "#src/tools/display-marker.ts";

import { anchorProperty } from "#src/tools/text-tool-schema-properties.ts";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.ts";
import {
  resolveAnchorSpanRange,
  selectionChanges,
  singleAnchorSpan,
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
    at: anchorProperty(
      "Replace only this selection. Do not combine with range boundaries. Omit all selectors when path is an issued selection of the intended text.",
    ),
    from: anchorProperty(
      "Include the unique opening match. Pass through or before; do not combine with after or at.",
    ),
    after: anchorProperty(
      "Begin after the unique opening match (on the next line if it reaches the end of a line). Pass through or before; do not combine with from or at. Use after and before together to replace the text between two markers and keep both.",
    ),
    through: anchorProperty(
      "Include the first following match. Pass from or after; do not combine with before or at.",
    ),
    before: anchorProperty(
      "Stop before the first following match (at the end of the previous line if it starts a line). Pass from or after; do not combine with through or at. To replace a block and keep the next block intact, use from for the first line of the current block and before for the first line of the next block.",
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
  readonly at?: unknown;
  readonly from?: unknown;
  readonly after?: unknown;
  readonly through?: unknown;
  readonly before?: unknown;
  readonly text: string;
}

export const replaceMutationTool: TextMutationToolRegistration<typeof replaceSchema> = {
  name: "replace",
  description:
    "Use replace to change text selected by a result, a single selector, or a pair of range boundaries.",

  promptSnippet: "Make precise file edits by replacing text using exact matches or anchors",
  parameters: replaceSchema,
  source: { field: "path", inherited: true },
  anchors: [
    {
      field: "at",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "from",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "after",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "through",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
    {
      field: "before",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
      pairedEnd: true,
    },
  ],
  pair: ["from", "through"],
  validateInput: replaceRange,
  mutate: async (context, parameters: ReplaceParameters) => {
    const range = replaceRange(parameters);
    refuseEndOfFileMarker(parameters.text);
    const startField = range?.[0] ?? "at";
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
    if (range === undefined && selections !== undefined) {
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

    const span =
      range === undefined
        ? singleAnchorSpan(context, starts, startField)
        : await resolveAnchorSpanRange(context, starts, range[0], range[1], true, {
            excludeStart: range[0] === "after",
            excludeEnd: range[1] === "before",
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

function replaceRange(
  input: Omit<ReplaceParameters, "text">,
): readonly [opening: "from" | "after", closing: "through" | "before"] | undefined {
  const opening =
    input.from !== undefined ? "from" : input.after !== undefined ? "after" : undefined;
  const closing =
    input.through !== undefined ? "through" : input.before !== undefined ? "before" : undefined;
  if (opening === undefined && closing === undefined) return undefined;

  if (input.at !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass at for a single selection or a pair of range boundaries, not both.",
    );
  if (input.from !== undefined && input.after !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass from or after, not both: from includes the opening match and after excludes it.",
    );
  if (input.through !== undefined && input.before !== undefined)
    throw new TextMutationInputError(
      "CONFLICTING_RANGE_BOUNDARIES",
      "Pass through or before, not both: through includes the closing match and before excludes it.",
    );
  if (opening === undefined)
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      `Pass from to include the opening match or after to exclude it when using ${closing}.`,
    );
  if (closing === undefined)
    throw new TextMutationInputError(
      "MISSING_RANGE_BOUNDARY",
      `Pass through to include the closing match or before to exclude it when using ${opening}. Use at instead for a single selection.`,
    );
  return [opening, closing];
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
