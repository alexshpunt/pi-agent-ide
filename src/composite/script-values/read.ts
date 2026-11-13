import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { resultReference } from "./result-reference.ts";
import type { ScriptValue, ScriptValueInput } from "./types.ts";

export type ImageBlock = Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>;

const imageBlockSchema = {
  type: "object",
  properties: {
    type: { const: "image" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type", "data", "mimeType"],
};

/** The value of one read source: text, raw bytes, a directory, an image or several frames. */
const sourceValueSchemas = [
  {
    type: "object",
    description:
      "Text, exactly as requested, without notices. Pass the value or its id to a source parameter.",
    properties: { text: { type: "string" }, id: { type: "string" } },
    required: ["text", "id"],
  },
  {
    type: "object",
    properties: { bytes: { type: "string" } },
    required: ["bytes"],
  },
  {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["entries"],
  },
  imageBlockSchema,
  {
    type: "object",
    description: "Several images, such as sequence frames, in source order.",
    properties: {
      type: { const: "images" },
      images: { type: "array", items: imageBlockSchema },
    },
    required: ["type", "images"],
  },
];

/**
 * A Codemode script's Read resolves to `{ text, id }` for text, `{ bytes }` for `raw:`,
 * `{ entries }` for a directory, Pi's image block for an image, `{ type: "images", images }` for
 * several frames, and an array of these for an array path, with null for each path that failed.
 * Values come from Read's complete data for script calls; a direct call keeps its readable result.
 */
export const readValue: ScriptValue = {
  schema: {
    anyOf: [
      ...sourceValueSchemas,
      {
        type: "array",
        description: "For an array path: the value of each path in order, null when it failed.",
        items: { anyOf: [...sourceValueSchemas, { type: "null" }] },
      },
    ],
  },
  project(input): JsonValue {
    const images = imageBlocks(input.content);
    if (input.script !== true) return imageValue(images) ?? input.shown;
    const data = successData(input.outcome);
    if (record(data) && data.kind === "list") return listValue(data, input, images);
    return sourceValue(data, resultReference(input.shown), images) ?? input.shown;
  },
  failed(input) {
    // A Read of several paths keeps the value of each path that succeeded.
    const data = record(input.outcome) ? input.outcome.data : undefined;
    if (input.script !== true || !record(data) || data.kind !== "list") return undefined;
    return listValue(data, input, imageBlocks(input.content));
  },
  failureReason({ outcome }) {
    if (!record(outcome) || !record(outcome.data) || outcome.data.kind !== "list") return undefined;
    const errors: unknown[] = Array.isArray(outcome.errors) ? outcome.errors : [];
    // Only the paths that failed, as a Read of each alone shows them; the others reached the
    // script as values.
    return (
      errors
        .flatMap((error) =>
          record(error) && typeof error.message === "string" ? [error.message] : [],
        )
        .join("\n") || undefined
    );
  },
};

/** The value of each path of a Read of several paths, in order; null for a path that failed. */
function listValue(
  data: Record<string, unknown>,
  input: ScriptValueInput,
  images: readonly ImageBlock[],
): JsonValue {
  const items: unknown[] = Array.isArray(data.items) ? data.items : [];
  // Each path's images follow each other in the content, in path order.
  let next = 0;
  return items.map((item) => {
    const itemData = successData(item);
    if (!record(itemData)) return null;
    const count = imageCount(itemData);
    const own = images.slice(next, next + count);
    next += count;
    const text = textOf(itemData);
    const id = text === undefined ? undefined : input.publish?.(item, text);
    return sourceValue(itemData, id, own) ?? null;
  });
}

/** The value of one source's complete data. */
function sourceValue(
  data: unknown,
  id: string | undefined,
  images: readonly ImageBlock[],
): JsonValue | undefined {
  if (!record(data)) return undefined;
  const image = imageValue(images);
  if (image !== undefined) return image;
  if (data.kind === "bytes" && Array.isArray(data.bytes))
    return { bytes: Buffer.from(data.bytes.filter(isByte)).toString("base64") };
  if (data.kind === "text" && Array.isArray(data.entries))
    return { entries: data.entries.filter((entry) => typeof entry === "string") };
  const text = textOf(data);
  return text === undefined || id === undefined ? undefined : { text, id };
}

/** The requested text of complete text data, a native text result, or several selected ranges. */
function textOf(data: Record<string, unknown>): string | undefined {
  if (data.kind === "text") {
    if (typeof data.text === "string") return data.text;
    const lines: unknown[] = Array.isArray(data.lines) ? data.lines : [];
    return lines
      .map((line) =>
        record(line) && typeof line.content === "string" && typeof line.lineEnding === "string"
          ? line.content + line.lineEnding
          : "",
      )
      .join("");
  }
  if (data.kind === "native" && Array.isArray(data.blocks)) {
    const blocks: unknown[] = data.blocks;
    return blocks
      .flatMap((block) => (record(block) && typeof block.text === "string" ? [block.text] : []))
      .join("\n");
  }
  if (data.kind === "resources" && Array.isArray(data.resources)) {
    const resources: unknown[] = data.resources;
    // Several selected ranges read as one text, as a direct Read shows them.
    return resources
      .flatMap((resource) => {
        const text = record(resource) ? textOf(resource) : undefined;
        return text === undefined ? [] : [text];
      })
      .join("\n");
  }
  return undefined;
}

function imageCount(data: unknown): number {
  if (!record(data) || data.kind !== "native" || !Array.isArray(data.blocks)) return 0;
  const blocks: unknown[] = data.blocks;
  return blocks.filter((block) => record(block) && block.type === "image").length;
}

function imageBlocks(content: ScriptValueInput["content"]): ImageBlock[] {
  return content
    .filter((block): block is ImageBlock => block.type === "image")
    .map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
}

function imageValue(images: readonly ImageBlock[]): JsonValue | undefined {
  const [first] = images;
  if (first === undefined) return undefined;
  if (images.length === 1) return { ...first };
  return { type: "images", images: images.map((image) => ({ ...image })) };
}

function successData(outcome: unknown): unknown {
  return record(outcome) && outcome.status === "success" ? outcome.data : undefined;
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
