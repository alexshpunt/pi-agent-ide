import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import type { TextMutationToolRegistration } from "#src/api/mutation-tool.ts";

export const writeSchema = Type.Object(
  {
    path: {
      ...resultInputSchema,
      description: "File path, or an unchanged whole-file result.",
    },
    // A string-only field keeps JSON-looking text intact; a union lets the tool-call layer parse it.
    content: Type.Optional(
      Type.String({ description: "Complete file content, saved exactly as given." }),
    ),
    image: Type.Optional(
      Type.Union(
        [
          Type.String(),
          Type.Object({
            type: Type.Literal("image"),
            data: Type.String(),
            mimeType: Type.String(),
          }),
          Type.Object({
            type: Type.Literal("images"),
            images: Type.Array(Type.Object({ data: Type.String(), mimeType: Type.String() })),
          }),
        ],
        {
          description:
            "Instead of content, an image that read returned: the result's UUID, or in Codemode the returned image value. Give path an image extension; several images become numbered files.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

interface WriteParameters {
  readonly path: unknown;
  readonly content?: unknown;
  readonly image?: unknown;
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
    // Images are written as files before text mutation starts.
    if (typeof parameters.content !== "string")
      throw new Error("Pass content with the text to write, or image with an image read returned.");
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
