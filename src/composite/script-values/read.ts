import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ScriptValue } from "./types.ts";

export type ImageBlock = Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>;

const imageBlockSchema = {
  type: "object",
  properties: {
    type: { const: "image" },
    data: { type: "string" },
    mimeType: { type: "string" },
    note: { type: "string" },
  },
  required: ["type", "data", "mimeType", "note"],
};

/**
 * A text Read resolves to its readable string, an image Read to a native image block, several
 * images (such as sequence frames) to `{ type: "images", note, images }`. The note is the readable
 * result string used for composition.
 */
export const readValue: ScriptValue = {
  schema: {
    anyOf: [
      { type: "string" },
      imageBlockSchema,
      {
        type: "object",
        description: "Several images, such as sequence frames, in source order.",
        properties: {
          type: { const: "images" },
          note: { type: "string" },
          images: {
            type: "array",
            items: { type: "object", properties: imageBlockSchema.properties },
          },
        },
        required: ["type", "note", "images"],
      },
    ],
  },
  project({ content, shown }): JsonValue {
    const images = content
      .filter((block): block is ImageBlock => block.type === "image")
      .map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
    const [first] = images;
    if (first === undefined) return shown;
    if (images.length === 1) return { ...first, note: shown };
    return { type: "images", note: shown, images };
  },
};
