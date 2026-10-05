import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const writeSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description:
        "Path to create or overwrite, or one whole-file source result. Partial scopes and multiple files are rejected.",
    },
    content: Type.String({ description: "File content" }),
  },
  { additionalProperties: false },
);

interface WriteParameters {
  readonly path: unknown;
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
        context.sourceFor("path"),
        {
          changes: [context.sourceDocument.replaceAll(parameters.content)],
          action: "overwritten",
        },
      ],
    ]),
  }),
};
