import { Type } from "typebox";

import { TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND } from "#src/api/plugin-protocol.js";
import {
  insertionAfterAnchor,
  insertionBeforeAnchor,
  insertionChanges,
  textSelections,
} from "#src/tools/text-selection.js";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const insertSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Source resource reference or file path. A returned SEARCH# reference can select insertion positions.",
      }),
    ),
    anchor: Type.Optional(
      Type.String({
        description:
          "Registered anchor or unique exact text locating the insertion. Required unless path already supplies a SEARCH selection. Inserts after the last containing line by default, or before the first containing line when before is true. This includes SEARCH :match and multiline exact text; the selected text is kept. Multiple matches on the same insertion line produce one insertion.",
      }),
    ),
    text: Type.String({
      description:
        "New text only. The tool supplies the line boundary; do not prefix a newline just to start a new line. For example, 'NEW' inserts one line, while '\\nNEW' intentionally adds a blank line before it. A missing trailing newline is supplied before following text; additional newlines remain intentional blank lines. When appending after an unterminated final line, the tool supplies the separator before the new text and removes one trailing newline from the payload. Payload line endings follow the destination file's LF/CRLF style.",
    }),
    before: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to false: insert after the last containing line. True: insert before the first containing line. The anchor's text and its lines are kept.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface InsertParameters {
  readonly path?: string;
  readonly anchor?: string;
  readonly text: string;
  readonly before?: boolean;
}

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description:
    "Use insert to add new text before or after selected lines while keeping existing text. Insertion is line-based, including for exact-text and SEARCH :match anchors.",

  promptSnippet:
    "Make precise file edits by inserting text before or after exact matches or anchors",
  parameters: insertSchema,
  source: { field: "path", inherited: true },
  anchors: [
    {
      field: "anchor",
      sourceField: "path",
      kinds: [TEXT_POSITION_ANCHOR_KIND, TEXT_SEARCH_ANCHOR_KIND],
    },
  ],
  mutate: async (context, parameters: InsertParameters) => {
    const anchors = await context.resolveAnchors("anchor");
    const selections = textSelections(anchors, "anchor");

    if (selections !== undefined) {
      const changes = insertionChanges(context, selections, parameters.text, parameters.before);
      return {
        edits: new Map(
          [...changes].map(([source, sourceChanges]) => [
            source,
            { changes: sourceChanges, action: "edited" as const },
          ]),
        ),
      };
    }

    const insertion = parameters.before === true ? insertionBeforeAnchor : insertionAfterAnchor;
    const [source, change] = insertion(context, anchors, "anchor", parameters.text);
    return {
      edits: new Map([[source, { changes: [change], action: "edited" }]]),
    };
  },
};
