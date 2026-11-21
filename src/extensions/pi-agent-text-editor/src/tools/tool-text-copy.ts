import { Type } from "typebox";

import {
  resultSourceProperty,
  sourceRangeProperties,
  targetProperties,
} from "#src/tools/text-tool-schema-properties.ts";

import {
  sourceSelectors,
  sourceTextSelector,
  targetSelectors,
  targetTextSelector,
  textSelectorAnchors,
  validateTransferSelectors,
} from "#src/api/text-selector-fields.ts";
import { resolveTextSpan, transferToTextSelector } from "#src/tools/text-selection.ts";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const copySchema = Type.Object(
  {
    path: resultSourceProperty(
      "Source selection, or a path with no text selectors to copy the whole file, directory or symlink. Omit to use the selector’s file.",
    ),
    ...sourceRangeProperties(
      "Select only this text to copy. Do not combine with range boundaries. Omit all selectors when path selects the intended text.",
    ),
    ...targetProperties(
      "Copying a directory merges into the target and keeps files that exist only there.",
    ),
  },
  { additionalProperties: false },
);
export const copyMutationTool: TextMutationToolRegistration<typeof copySchema> = {
  name: "copy",
  wholeFileOperation: "copy",
  description: "Use copy to copy a file or directory, or to duplicate text in another place.",

  promptSnippet: "Copy filesystem objects or selected text",
  parameters: copySchema,
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

    const [target, change] = await transferToTextSelector(
      context,
      copied,
      targetTextSelector(parameters),
    );
    return { edits: new Map([[target.source, { changes: [change], action: "edited" }]]) };
  },
};
