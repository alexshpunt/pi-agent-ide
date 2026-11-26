import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Anonymous host with a fixed lifetime. It offers no shorter expiry than one hour. */
export const TEMPORARY_FILE_HOST = "https://litterbox.catbox.moe/resources/internals/api.php";
export const TEMPORARY_FILE_LIFETIME = "1h";
/** Catbox accounts can delete their own uploads, so the copy lives only as long as the search. */
export const CATBOX_ACCOUNT_HOST = "https://catbox.moe/user/api.php";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};
const transport = () =>
  ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-web-search.runtime-transport")] as
    | typeof fetch
    | undefined) ?? globalThis.fetch;

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface PublicImage {
  url: string;
  /** Set when the image was uploaded: removes the copy from an account host and returns a warning if that failed. */
  remove?: () => Promise<string | undefined>;
}

/**
 * Returns the public URL Serper Lens can fetch: the given URL itself, or an upload of a local image file.
 * With a Catbox account hash the upload goes to that account and `remove` deletes it; otherwise it goes
 * to the anonymous host, which deletes it after one hour.
 */
export async function publicImageUrl(
  image: string,
  cwd: string,
  signal?: AbortSignal,
  catboxUserhash?: string,
): Promise<PublicImage> {
  const trimmed = image.trim();
  if (isWebUrl(trimmed)) return { url: trimmed };
  const file = trimmed.startsWith("file:") ? fileURLToPath(trimmed) : path.resolve(cwd, trimmed);
  const mime = MIME_BY_EXTENSION[path.extname(file).toLowerCase()];
  if (!mime)
    throw new Error(
      `Not uploading ${file}: only image files (${Object.keys(MIME_BY_EXTENSION).join(", ")}) can be searched.`,
    );
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Image file not found: ${file}`);
  if (info.size > MAX_UPLOAD_BYTES)
    throw new Error(`Image file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB: ${file}`);
  const form = new FormData();
  form.set("reqtype", "fileupload");
  if (catboxUserhash) form.set("userhash", catboxUserhash);
  else form.set("time", TEMPORARY_FILE_LIFETIME);
  form.set("fileToUpload", new File([await readFile(file)], path.basename(file), { type: mime }));
  const response = await transport()(catboxUserhash ? CATBOX_ACCOUNT_HOST : TEMPORARY_FILE_HOST, {
    method: "POST",
    body: form,
    signal,
  });
  const body = (await response.text()).trim();
  if (!response.ok || !isWebUrl(body))
    throw new Error(
      `The file host did not accept the image (HTTP ${response.status}): ${body.slice(0, 200)}`,
    );
  if (!catboxUserhash) return { url: body };
  const name = new URL(body).pathname.split("/").pop() ?? "";
  return {
    url: body,
    async remove() {
      const removal = new FormData();
      removal.set("reqtype", "deletefiles");
      removal.set("userhash", catboxUserhash);
      removal.set("files", name);
      try {
        const answer = await transport()(CATBOX_ACCOUNT_HOST, { method: "POST", body: removal });
        const reply = (await answer.text()).trim();
        return answer.ok && /deleted/iu.test(reply)
          ? undefined
          : `Could not delete the uploaded copy ${body} from your Catbox account: ${reply.slice(0, 200)}`;
      } catch (error) {
        return `Could not delete the uploaded copy ${body} from your Catbox account: ${error instanceof Error ? error.message : "request failed"}`;
      }
    },
  };
}
