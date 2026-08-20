import { extractReadableHtml } from "./extract-readable-html.js";

import type { ContentConverter } from "pi-agent-resource";

const htmlMediaTypes = new Set(["application/xhtml+xml", "text/html"]);
const htmlSignature = /^\u{FEFF}?\s*(?:<!doctype\s+html\b|<(?:article|body|head|html)\b)/iu;

export function createHtmlContentConverter(): ContentConverter {
  return {
    id: "html",
    description: "HTML and XHTML pages converted to Markdown.",
    async tryConvert(input, context) {
      if (!isHtmlInput(input.bytes, input.mediaType)) {
        return { kind: "not-handled" };
      }

      const initialCancellation = cancellationError(context.signal);

      if (initialCancellation !== undefined) {
        return { kind: "failed", error: initialCancellation };
      }

      let html: string;

      try {
        html = new TextDecoder("utf8", { fatal: true }).decode(input.bytes);
      } catch (error) {
        return {
          kind: "failed",
          error: new TypeError(`${input.source} is not valid UTF-8 HTML`, { cause: error }),
        };
      }

      const extracted = await extractReadableHtml(html, input.source);
      const finalCancellation = cancellationError(context.signal);

      if (finalCancellation !== undefined) {
        return { kind: "failed", error: finalCancellation };
      }

      const text =
        extracted.title.length === 0
          ? extracted.content
          : extracted.content.length === 0
            ? `# ${extracted.title}`
            : `# ${extracted.title}\n\n${extracted.content}`;

      return { kind: "converted", content: [{ type: "text", text }] };
    },
  };
}

export function isHtmlInput(bytes: Uint8Array, mediaType: string | undefined): boolean {
  if (mediaType !== undefined) {
    const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

    if (htmlMediaTypes.has(normalized)) {
      return true;
    }
  }

  const prefix = new TextDecoder("utf8").decode(bytes.subarray(0, 1024));
  return htmlSignature.test(prefix);
}

function cancellationError(signal: AbortSignal | undefined): Error | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }

  return signal.reason instanceof Error ? signal.reason : abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
