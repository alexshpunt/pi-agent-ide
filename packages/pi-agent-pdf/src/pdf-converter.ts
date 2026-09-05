import type { AgentContent, ContentConverter } from "pi-agent-resource";

const pdfHeader = new TextEncoder().encode("%PDF-");
const maximumHeaderOffset = 1_024;

export function createPdfContentConverter(): ContentConverter {
  return {
    id: "pdf",
    description: "PDF documents converted to readable text by page.",
    async tryConvert(input, context) {
      const cancellation = cancellationError(context.signal);

      if (cancellation !== undefined) {
        return { kind: "failed", error: cancellation };
      }

      if (!isPdf(input.bytes)) {
        return isPdfMediaType(input.mediaType)
          ? { kind: "failed", error: new TypeError(`${input.source} is not a valid PDF document`) }
          : { kind: "not-handled" };
      }

      try {
        const content = await createPdfContent(input.bytes, context.signal);
        return { kind: "converted", content };
      } catch (error) {
        return {
          kind: "failed",
          error:
            cancellationError(context.signal) ??
            new TypeError(`Unable to read PDF document ${input.source}: ${errorMessage(error)}`, {
              cause: error,
            }),
        };
      }
    },
  };
}

export function isPdf(bytes: Uint8Array): boolean {
  const searchLength = Math.min(bytes.length, maximumHeaderOffset + pdfHeader.length);

  for (let offset = 0; offset + pdfHeader.length <= searchLength; offset += 1) {
    if (pdfHeader.every((byte, index) => bytes[offset + index] === byte)) {
      return true;
    }
  }

  return false;
}

export async function createPdfContent(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AgentContent> {
  throwIfAborted(signal);

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  throwIfAborted(signal);

  // PDF.js may transfer ownership of its input to a worker. Preserve the caller's bytes.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  let destruction: Promise<void> | undefined;
  const destroy = (): Promise<void> => (destruction ??= loadingTask.destroy());
  const abort = (): void => {
    void destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const document = await loadingTask.promise;
    throwIfAborted(signal);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      throwIfAborted(signal);
      const text = extractPageText(textContent.items);
      pages.push(
        [
          `## Page ${pageNumber} of ${document.numPages}`,
          "",
          text.length === 0 ? "[No extractable text on this page.]" : text,
        ].join("\n"),
      );
      page.cleanup();
    }

    return [
      {
        type: "text",
        text: ["# PDF document", ...pages].join("\n\n"),
      },
    ];
  } finally {
    signal?.removeEventListener("abort", abort);
    await destroy().catch(() => {});
  }
}

interface PdfTextItem {
  readonly str: string;
  readonly hasEOL?: boolean;
}

function extractPageText(items: readonly unknown[]): string {
  let result = "";

  for (const value of items) {
    if (!isPdfTextItem(value) || value.str.length === 0) {
      continue;
    }

    if (result.length > 0 && !endsWithWhitespace(result) && !startsWithWhitespace(value.str)) {
      result += " ";
    }

    result += value.str;

    if (value.hasEOL === true && !result.endsWith("\n")) {
      result += "\n";
    }
  }

  return result.trim();
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return (
    typeof value === "object" && value !== null && "str" in value && typeof value.str === "string"
  );
}

function startsWithWhitespace(value: string): boolean {
  return /^\s/u.test(value);
}

function endsWithWhitespace(value: string): boolean {
  return /\s$/u.test(value);
}

function isPdfMediaType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  const cancellation = cancellationError(signal);

  if (cancellation !== undefined) {
    throw cancellation;
  }
}

function cancellationError(signal: AbortSignal | undefined): Error | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }

  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
