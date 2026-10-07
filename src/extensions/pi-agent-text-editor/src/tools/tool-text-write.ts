import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const writeSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description:
        "File path or one whole-file source result. Partial file scopes and multiple files are rejected. Use shell:<session> to send input to a running terminal.",
    },
    content: Type.String({
      description:
        "Complete file contents, or exact terminal input. Terminal input does not add Enter.",
    }),
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
    "Use write to create or deliberately overwrite a whole file, or send input to a running terminal.",

  promptSnippet: "Create or overwrite files",
  parameters: writeSchema,
  source: { field: "path" },
  anchors: [],
  mutate: (context, parameters: WriteParameters) => ({
    edits: new Map([
      [
        context.sourceFor("path"),
        {
          changes:
            context.sourceDocument.content === parameters.content
              ? []
              : [context.sourceDocument.replaceAll(parameters.content)],
          action: "overwritten",
        },
      ],
    ]),
  }),
};
