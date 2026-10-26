import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.js";

export const writeSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description: "File path, or an unchanged whole-file result.",
    },
    content: Type.Union(
      [
        Type.String(),
        Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
        Type.Object({
          type: Type.Literal("images"),
          images: Type.Array(Type.Object({ data: Type.String(), mimeType: Type.String() })),
        }),
      ],
      {
        description:
          "Complete file content. To save an image that read returned, pass that read result or its UUID and give path an image extension; several images become numbered files.",
      },
    ),
  },
  { additionalProperties: false },
);

interface WriteParameters {
  readonly path: unknown;
  readonly content: unknown;
}

export const writeMutationTool: TextMutationToolRegistration<typeof writeSchema> = {
  name: "write",
  description:
    "Use write to create a file or replace all of its content, or to type into a terminal session.",

  promptSnippet: "Create or overwrite files",
  parameters: writeSchema,
  source: { field: "path" },
  anchors: [],
  mutate: (context, parameters: WriteParameters) => {
    // Image content is written as files before text mutation starts.
    if (typeof parameters.content !== "string")
      throw new Error("Image content must name images a Read returned.");
    const content = parameters.content;
    return {
      edits: new Map([
        [
          context.sourceFor("path"),
          {
            changes:
              context.sourceDocument.content === content
                ? []
                : [context.sourceDocument.replaceAll(content)],
            action: "overwritten",
          },
        ],
      ]),
    };
  },
};
