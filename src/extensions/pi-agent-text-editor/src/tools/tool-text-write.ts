import { Type } from "typebox";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const writeSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to create or overwrite" }),
    content: Type.String({ description: "File content" }),
  },
  { additionalProperties: false },
);

interface WriteParameters {
  readonly path: string;
  readonly content: string;
}

export const writeMutationTool: TextMutationToolRegistration<typeof writeSchema> = {
  name: "write",
  description:
    "Use write to create a new file or deliberately replace a file's entire contents. Supply the complete new text; existing contents are overwritten.",

  promptSnippet: "Create or overwrite files",
  parameters: writeSchema,
  source: { field: "path" },
  anchors: [],
  mutate: (context, parameters: WriteParameters) => ({
    edits: new Map([
      [
        parameters.path,
        {
          changes: [context.sourceDocument.replaceAll(parameters.content)],
          action: "overwritten",
        },
      ],
    ]),
  }),
};
