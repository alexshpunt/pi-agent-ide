import { parseHTML } from "linkedom";

interface HtmlElementView {
  readonly textContent: string | null;
  remove(): void;
}

interface HtmlDocumentView {
  readonly body: HtmlElementView | null;
  readonly documentElement: HtmlElementView | null;
  querySelector(selector: string): HtmlElementView | null;
  querySelectorAll(selector: string): Iterable<HtmlElementView>;
}

export interface ExtractedHtml {
  readonly content: string;
  readonly title: string;
  readonly usedFallback: boolean;
}

export type HtmlExtractor = (
  html: string,
  source: string,
) => Promise<{ readonly content: string; readonly title: string }>;

export async function extractReadableHtml(
  html: string,
  source: string,
  extractor: HtmlExtractor = extractWithDefuddle,
): Promise<ExtractedHtml> {
  try {
    const result = await extractor(html, source);
    return {
      content: result.content.trim(),
      title: result.title.trim(),
      usedFallback: false,
    };
  } catch {
    const fallback = extractPlainText(html, source);
    return { ...fallback, usedFallback: true };
  }
}

async function extractWithDefuddle(
  html: string,
  source: string,
): Promise<{ readonly content: string; readonly title: string }> {
  const document = parseDocument(html, source);
  const { Defuddle } = await import("defuddle/node");
  const result = await Defuddle(document as Document, source, {
    markdown: true,
    useAsync: false,
  });

  return {
    content: result.content,
    title: result.title,
  };
}

function extractPlainText(
  html: string,
  source: string,
): { readonly content: string; readonly title: string } {
  const document = parseDocument(html, source);

  for (const element of document.querySelectorAll(
    "script, style, nav, footer, header, aside, noscript, template",
  )) {
    element.remove();
  }

  const root = document.querySelector("article, main") ?? document.body ?? document.documentElement;
  const content = normalizeWhitespace(root?.textContent ?? "");
  const title = normalizeWhitespace(document.querySelector("title")?.textContent ?? "");
  return { content, title };
}

function parseDocument(html: string, source: string): HtmlDocumentView {
  const parsed = parseHTML(html) as { readonly document: HtmlDocumentView };

  try {
    Object.defineProperty(parsed.document, "location", {
      value: new URL(source),
      configurable: true,
    });
  } catch {
    // The web resolver validates HTTP(S) sources before conversion.
  }

  return parsed.document;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
