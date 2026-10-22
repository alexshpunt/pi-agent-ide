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
          "Complete file contents, or exact terminal input. Terminal input does not add Enter. To save images a Read returned, pass that Read result itself in Codemode, or its UUID or RESULT# reference, and name the file with the image's extension (.png, .jpg, .webp, .gif). Several images become numbered files <path>-01.png…, or frame-01.png… inside a folder path.",
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
    "Use write to create or deliberately overwrite a whole file, or send input to a running terminal.",

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
