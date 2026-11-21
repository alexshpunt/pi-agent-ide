import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import {
  sourceSelectors,
  sourceTextSelector,
  textSelectorAnchors,
} from "#src/api/text-selector-fields.ts";
import { resolveTextSpan, selectionChanges, textSelections } from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const deleteSchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection to remove, or a path with no text selectors to delete the file, directory or symlink itself. Omit to use the selector’s file.",
    ),
    ...sourceRangeProperties(
      "Remove only this selection. Do not combine with range boundaries. Omit all selectors when path selects the intended text.",
    ),
  },
  { additionalProperties: false },
);
export const deleteMutationTool: TextMutationToolRegistration<typeof deleteSchema> = {
  name: "delete",
  wholeFileOperation: "delete",
  description:
    "Use delete to remove text, delete a file or directory, or end a terminal or debugger session.",

  promptSnippet:
    "Delete files or selected text, terminate terminal or debugger sessions, or remove debugger breakpoints",
  parameters: deleteSchema,
  source: { field: "path", inherited: true },
  anchors: textSelectorAnchors("path", sourceSelectors, ["through", "before"]),
  validateInput: sourceTextSelector,
  mutate: async (context, parameters) => {
    const selector = sourceTextSelector(parameters) ?? { kind: "single", first: "at" };
    const starts = await context.resolveAnchors(selector.first);
    const selections = textSelections(starts, selector.first);
    if (selector.kind === "single" && selections !== undefined) {
      const changes = selectionChanges(context, selections, "");
      return {
        edits: new Map(
          [...changes].map(([source, sourceChanges]) => [
            source,
            { changes: sourceChanges, action: "edited" as const },
          ]),
        ),
      };
    }

    const span = await resolveTextSpan(context, selector, starts);
    return {
      edits: new Map([
        [
          span.source,
          { changes: [context.documentFor(span.source).delete(span)], action: "edited" },
        ],
      ]),
    };
  },
};
