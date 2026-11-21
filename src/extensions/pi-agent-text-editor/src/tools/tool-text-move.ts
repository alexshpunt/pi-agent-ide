import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import {
  selectorFields,
  sourceSelectors,
  sourceTextSelector,
  targetSelectors,
  targetTextSelector,
  textSelectorAnchors,
  validateTransferSelectors,
} from "#src/api/text-selector-fields.ts";
import { resolveTextSpan, transferToTextSelector } from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";
import type { TextChange } from "#src/core/text-change-engine.ts";

export const moveSchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection, or a path with no text selectors to move the whole file, directory or symlink.",
    ),
    ...sourceRangeProperties(
      "Select only this text to move. Do not combine with range boundaries. Omit all selectors when path selects the intended text.",
    ),
    ...targetProperties("Moving a directory replaces the target directory."),
  },
  { additionalProperties: false },
);
export const moveMutationTool: TextMutationToolRegistration<typeof moveSchema> = {
  name: "move",
  wholeFileOperation: "move",
  description:
    "Use move to move or rename a file or directory, or to cut text from one place and put it in another.",

  promptSnippet: "Move filesystem objects or selected text",
  parameters: moveSchema,
  source: { field: "path", inherited: true, targets: [{ field: "target", fallbackTo: "path" }] },
  anchors: [
    ...textSelectorAnchors("path", sourceSelectors, ["through", "before"]),
    ...textSelectorAnchors("target", targetSelectors, ["targetThrough", "targetBefore"]),
  ],
  validateInput: validateTransferSelectors,
  mutate: async (context, parameters) => {
    const selector = sourceTextSelector(parameters) ?? { kind: "single", first: "at" };
    const sourceSpan = await resolveTextSpan(context, selector);
    const copied = context.documentFor(sourceSpan.source).transfer(sourceSpan);
    const deletion = {
      ...context.documentFor(sourceSpan.source).delete(sourceSpan),
      selectorFields: selectorFields(selector),
    };

    const [targetSpan, destination] = await transferToTextSelector(
      context,
      copied,
      targetTextSelector(parameters),
    );
    const target = targetSpan.source;

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
