import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

interface HtmlElementView
{
    readonly textContent: string | null;
    remove(): void;
}

interface HtmlDocumentView
{
    readonly body: HtmlElementView | null;
    readonly documentElement: HtmlElementView | null;
    querySelector(selector: string): HtmlElementView | null;
    querySelectorAll(selector: string): Iterable<HtmlElementView>;
}

export interface ExtractedHtml
{
    readonly content: string;
    readonly title: string;
    readonly usedFallback: boolean;
}

export type HtmlExtractor = (
    html: string,
    source: string,
) => Promise<{ readonly content: string; readonly title: string; }>;

export async function extractReadableHtml(
    html: string,
    source: string,
    extractor: HtmlExtractor = extractWithDefuddle,
): Promise<ExtractedHtml>
{
    try
    {
        const result = await extractor(html, source);
        return {
            content: result.content.trim(),
            title: result.title.trim(),
            usedFallback: false,
        };
    }
    catch
    {
        const fallback = extractPlainText(html);
        return { ...fallback, usedFallback: true };
    }
}

async function extractWithDefuddle(
    html: string,
    source: string,
): Promise<{ readonly content: string; readonly title: string; }>
{
    const document = parseDocument(html);
    const result = await Defuddle(
        document,
        source,
        {
            markdown: true,
            useAsync: false,
        },
    );

    return {
        content: result.content,
        title: result.title,
    };
}

function extractPlainText(html: string): { readonly content: string; readonly title: string; }
{
    const document = parseDocument(html);

    for (
        const element of document.querySelectorAll(
            "script, style, nav, footer, header, aside, noscript, template",
        )
    )
    {
        element.remove();
    }

    const root = document.querySelector("article, main") ?? document.body ?? document.documentElement;
    const content = normalizeWhitespace(root?.textContent ?? "");
    const title = normalizeWhitespace(document.querySelector("title")?.textContent ?? "");
    return { content, title };
}

function parseDocument(html: string): HtmlDocumentView
{
    const parsed = parseHTML(html) as unknown as { readonly document: HtmlDocumentView; };
    return parsed.document;
}

function normalizeWhitespace(value: string): string
{
    return value.replace(/\s+/gu, " ").trim();
}
