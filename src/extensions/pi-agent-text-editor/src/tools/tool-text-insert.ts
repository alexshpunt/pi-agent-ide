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
          "Pass a file path, source resource reference, unchanged Read/Search/Select/edit result, or its UUID. Result inputs select only their registered ranges.",
      }),
    ),
    anchor: Type.Optional(
      Type.String({
        description:
          "For text edits, use a registered anchor or unique exact text to locate the insertion. Omit anchor when path already supplies the intended selection; otherwise it is required. For live resources, follow the action rules above.",
      }),
    ),
    text: Type.String({
      minLength: 1,
      description:
        "For text edits, supply non-empty new text. The tool adds missing line breaks between the insertion and existing text. Add a leading newline only for an intentional blank line, not to start a new line. Payload newlines are kept, with line endings converted to the file's LF/CRLF style. No trailing newline is added at EOF.",
    }),
    separation: Type.Optional(
      Type.Union([Type.Literal("line"), Type.Literal("blank-line")], {
        description:
          "For text edits, defaults to line: separate inserted text from existing lines without adding extra blank lines. Use blank-line to add only missing blank lines between the insertion and existing text.",
      }),
    ),
    before: Type.Optional(
      Type.Boolean({
        description:
          "For text edits, defaults to false: insert after the last containing line of each selection. With true, insert before its first containing line. Selected text is kept. Multiple selections on the same insertion line produce one insertion.",
      }),
    ),
  },
  { additionalProperties: false },
);

interface InsertParameters {
  readonly path?: string;
  readonly anchor?: string;
  readonly text: string;
  readonly separation?: "line" | "blank-line";
  readonly before?: boolean;
}

export const insertMutationTool: TextMutationToolRegistration<typeof insertSchema> = {
  name: "insert",
  description:
    "Use insert to edit text or act on a live resource. For text edits, add new text before or after selected lines while keeping existing text. Insertion is line-based, including for exact-text and SEARCH :match anchors. An empty result selection makes no changes and is not an error.",

  promptSnippet: "Insert file text, send terminal keys, or perform debugger actions",
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
    if (parameters.text.length === 0) throw new Error("Insert text must not be empty.");
    const anchors = await context.resolveAnchors("anchor");
    const selections = textSelections(anchors, "anchor");

    if (selections !== undefined) {
      const changes = insertionChanges(
        context,
        selections,
        parameters.text,
        parameters.before,
        parameters.separation,
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

    const insertion = parameters.before === true ? insertionBeforeAnchor : insertionAfterAnchor;
    const [source, change] = insertion(
      context,
      anchors,
      "anchor",
      parameters.text,
      parameters.separation,
    );
    return {
      edits: new Map([[source, { changes: [change], action: "edited" }]]),
    };
  },
};
