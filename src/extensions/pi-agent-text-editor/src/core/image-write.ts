import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, ResultImageStore } from "pi-agent-resource";
import type { FileMutationBatchResult } from "#src/core/mutation-result/file-mutation-result.js";

const extensions: Readonly<Record<string, readonly string[]>> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};

/** One image file a Write produces. */
export interface ImageFile {
  readonly source: string;
  readonly bytes: Uint8Array;
}

/**
 * Plan the files for Write content that names images: a Codemode Read image value, or an issued
 * Read result UUID/RESULT# reference. Returns undefined for ordinary text content.
 * One image goes to the path itself; several go to `<name>-01.png`… beside it, or into a folder.
 */
export async function planImageWrite(
  target: unknown,
  content: unknown,
  store: ResultImageStore | undefined,
  cwd: string,
): Promise<readonly ImageFile[] | undefined> {
  const images = typeof content === "string" ? store?.images(content, cwd) : contentImages(content);
  if (images === undefined) return undefined;
  if (images.length === 0) throw new Error("The result contains no images to write.");
  if (typeof target !== "string" || target.length === 0)
    throw new Error("Name the file to write the image to.");
  if (/^[a-z][a-z\d+.-]+:/iu.test(target) && !target.startsWith("file://"))
    throw new Error("Images can only be written to local files.");
  const file = target.startsWith("file://") ? fileURLToPath(target) : path.resolve(cwd, target);
  const extension = path.extname(file).toLowerCase();
  const [first] = images;
  if (images.length === 1 && first !== undefined) return [imageFile(file, extension, first)];
  const folder =
    /[\\/]$/u.test(target) || (await stat(file).catch(() => undefined))?.isDirectory() === true;
  const named = !folder && Object.values(extensions).some((list) => list.includes(extension));
  const base = folder ? path.join(file, "frame") : named ? file.slice(0, -extension.length) : file;
  const width = Math.max(2, String(images.length).length);
  return images.map((image, index) => {
    const suffix = named ? extension : (extensions[image.mimeType]?.[0] ?? "");
    return imageFile(`${base}-${String(index + 1).padStart(width, "0")}${suffix}`, suffix, image);
  });
}

/** Report written image files; Codemode receives `{ ok, files }`. */
export function imageWriteResult(
  files: readonly ImageFile[],
): AgentToolResult<FileMutationBatchResult> {
  const sources = files.map((file) => file.source);
  return {
    content: [
      {
        type: "text",
        text: `Wrote ${files.length === 1 ? "image" : `${files.length} images`}:\n${sources.join("\n")}`,
      },
    ],
    details: {
      results: [],
      metadata: {
        semanticAction: {
          kind: "direct-mutation",
          ok: true,
          effect: "applied",
          source: sources[0],
          files: sources,
          script: { ok: true, files: sources },
        },
      },
    },
  };
}

function imageFile(source: string, extension: string, image: ImageContent): ImageFile {
  const allowed = extensions[image.mimeType];
  if (allowed === undefined) throw new Error(`Cannot write ${image.mimeType} images.`);
  if (!allowed.includes(extension))
    throw new Error(`Name the file with ${allowed.join(" or ")} for a ${image.mimeType} image.`);
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== image.data)
    throw new Error("Image data is not valid base64.");
  return { source, bytes };
}

/** Parse a Codemode Read image value; other values are not image content. */
function contentImages(content: unknown): ImageContent[] | undefined {
  if (!isRecord(content)) return undefined;
  const items: unknown[] | undefined =
    content.type === "image"
      ? [content]
      : content.type === "images" && Array.isArray(content.images)
        ? content.images
        : undefined;
  return items?.map((item) => {
    if (!isRecord(item) || typeof item.data !== "string" || typeof item.mimeType !== "string")
      throw new Error("Each image needs base64 data and a mimeType.");
    return { type: "image", data: item.data, mimeType: item.mimeType };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
