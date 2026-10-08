import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";

type Content = AgentToolResult<unknown>["content"];

/** Shared useful-content budgets. Notices and composition metadata are added afterward. */
export const IDE_OUTPUT_LIMITS = {
  bytes: DEFAULT_MAX_BYTES,
  lines: DEFAULT_MAX_LINES,
  pixels: 4_000_000,
  images: 20,
  imageBytes: 20 * 1024 * 1024,
} as const;

/** Bound the complete useful payload, not each individual content block. */
export async function limitIdeOutput(
  content: Content,
  metadata: string | readonly string[] = "",
  saveFullOutput?: (text: string) => Promise<string>,
) {
  const suffixes = typeof metadata === "string" ? [metadata] : metadata;
  const retained: string[] = [];
  const text = content
    .flatMap((block) => {
      if (block.type !== "text") return [];
      const suffix = suffixes.find(
        (candidate) => candidate.length > 0 && block.text.endsWith(candidate),
      );
      if (!suffix) return [block.text];
      retained.push(suffix);
      return [block.text.slice(0, -suffix.length)];
    })
    .join("\n");
  const metadataSuffix = retained.join("");
  const truncated = truncateHead(text, {
    maxBytes: IDE_OUTPUT_LIMITS.bytes,
    maxLines: IDE_OUTPUT_LIMITS.lines,
  });
  const notices: string[] = [];
  let fullOutput: string | undefined;
  if (truncated.truncated && saveFullOutput !== undefined) {
    try {
      fullOutput = await saveFullOutput(text);
    } catch {
      notices.push("[Full output could not be saved. Narrow the request to inspect it.]");
    }
  }
  if (truncated.truncated)
    notices.push(
      `[Output truncated: useful content is limited to ${IDE_OUTPUT_LIMITS.bytes} bytes / ${IDE_OUTPUT_LIMITS.lines} lines. Narrow the request or read a smaller source range.]`,
    );
  if (fullOutput !== undefined)
    notices.push(
      `[Full output: ${JSON.stringify(fullOutput)}. Read with offset/limit, or read ${JSON.stringify("raw:" + fullOutput)} for byte ranges. Available until this runtime is disposed.]`,
    );
  const candidates = content.filter((block) => block.type === "image");
  const selected = candidates.slice(0, IDE_OUTPUT_LIMITS.images);
  const images: Content = [];
  const pixelShare = Math.floor(IDE_OUTPUT_LIMITS.pixels / Math.max(1, selected.length));
  let bytes = 0;
  let omitted = candidates.length - selected.length;
  for (const [index, block] of selected.entries()) {
    try {
      const original = Buffer.from(block.data, "base64");
      const decoded = await loadImage(original);
      const scale = Math.min(1, Math.sqrt(pixelShare / (decoded.width * decoded.height)));
      const height = Math.min(pixelShare, Math.max(1, Math.floor(decoded.height * scale)));
      const width = Math.min(
        Math.floor(pixelShare / height),
        Math.max(1, Math.floor(decoded.width * scale)),
      );
      let data: Buffer = original;
      let mimeType = block.mimeType;
      if (scale < 1 || bytes + data.byteLength > IDE_OUTPUT_LIMITS.imageBytes) {
        const canvas = createCanvas(width, height);
        canvas.getContext("2d").drawImage(decoded, 0, 0, width, height);
        data = await canvas.encode("png");
        mimeType = "image/png";
      }
      if (bytes + data.byteLength > IDE_OUTPUT_LIMITS.imageBytes) {
        omitted++;
        continue;
      }
      bytes += data.byteLength;
      images.push({ type: "image", data: data.toString("base64"), mimeType });
      if (scale < 1)
        notices.push(
          `[Image ${index + 1} resized from ${decoded.width}x${decoded.height} to ${width}x${height} to fit the shared media budget.]`,
        );
    } catch {
      omitted++;
      notices.push(`[Image ${index + 1} could not be decoded and was not returned.]`);
    }
  }
  if (omitted > 0)
    notices.push(
      `[${omitted} images omitted from the result. Read fewer frames or a smaller image region.]`,
    );
  return {
    text: truncated.firstLineExceedsLimit ? bytePrefix(text) : truncated.content,
    textTruncated: truncated.truncated,
    images,
    notices,
    metadataSuffix,
    fullOutput,
  };
}

/** Keep complete UTF-8 code points when even one output line exceeds the shared budget. */
function bytePrefix(text: string): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > IDE_OUTPUT_LIMITS.bytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}
