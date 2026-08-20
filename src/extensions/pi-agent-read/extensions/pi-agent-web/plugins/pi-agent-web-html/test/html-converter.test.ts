import { expect, test } from "vitest";

import { extractReadableHtml } from "../src/extract-readable-html.js";
import { createHtmlContentConverter } from "../src/html-converter.js";

const encoder = new TextEncoder();
const article = `<!doctype html>
<html>
<head><title>Deep Work</title><style>.noise { display: none; }</style></head>
<body>
<header>Site header</header>
<nav>Navigation noise</nav>
<main><article>
<h1>Deep Work</h1>
<p>Main paragraph with enough useful words to make extraction straightforward for this deterministic fixture.</p>
<a href="next">Continue reading</a>
</article></main>
<aside>Sidebar noise</aside>
<script>window.unwanted = true;</script>
<footer>Footer noise</footer>
</body>
</html>`;

test("extracts an HTML article as titled Markdown without page chrome", async () => {
  const converter = createHtmlContentConverter();
  const outcome = await converter.tryConvert(
    {
      source: "https://example.test/posts/current",
      bytes: encoder.encode(article),
      mediaType: "text/html; charset=utf-8",
    },
    {},
  );

  expect(outcome.kind).toBe("converted");

  if (outcome.kind !== "converted" || outcome.content[0].type !== "text") {
    throw new Error("HTML fixture did not become text");
  }

  const markdown = outcome.content[0].text;
  expect(markdown).toContain("# Deep Work");
  expect(markdown).toContain("Main paragraph");
  expect(markdown).toContain("[Continue reading](https://example.test/posts/next)");
  expect(markdown).not.toContain("Navigation noise");
  expect(markdown).not.toContain("Sidebar noise");
  expect(markdown).not.toContain("window.unwanted");
});

test("uses a readable plain-text fallback when extraction fails", async () => {
  const result = await extractReadableHtml(
    article,
    "https://example.test/posts/current",
    async () => {
      throw new Error("forced extraction failure");
    },
  );

  expect(result.usedFallback).toBe(true);
  expect(result.title).toBe("Deep Work");
  expect(result.content).toContain("Main paragraph");
  expect(result.content).not.toContain("Navigation noise");
  expect(result.content).not.toContain("window.unwanted");
});

test("recognizes XHTML and a conservative HTML byte signature", async () => {
  const converter = createHtmlContentConverter();

  await expect(
    converter.tryConvert(
      {
        source: "https://example.test/xhtml",
        bytes: encoder.encode("<article><p>XHTML body content for extraction.</p></article>"),
        mediaType: "application/xhtml+xml",
      },
      {},
    ),
  ).resolves.toMatchObject({ kind: "converted" });
  await expect(
    converter.tryConvert(
      {
        source: "https://example.test/sniffed",
        bytes: encoder.encode(article),
        mediaType: "application/octet-stream",
      },
      {},
    ),
  ).resolves.toMatchObject({ kind: "converted" });
});

test("declines non-HTML and fails malformed declared HTML", async () => {
  const converter = createHtmlContentConverter();

  await expect(
    converter.tryConvert(
      {
        source: "https://example.test/text",
        bytes: encoder.encode("plain text"),
        mediaType: "text/plain",
      },
      {},
    ),
  ).resolves.toEqual({ kind: "not-handled" });

  const malformed = await converter.tryConvert(
    {
      source: "https://example.test/broken",
      bytes: new Uint8Array([0xc3, 0x28]),
      mediaType: "text/html",
    },
    {},
  );
  expect(malformed.kind).toBe("failed");
});

test("returns cancellation instead of parsing or falling back", async () => {
  const converter = createHtmlContentConverter();
  const controller = new AbortController();
  controller.abort();

  const outcome = await converter.tryConvert(
    {
      source: "https://example.test/cancelled",
      bytes: encoder.encode(article),
      mediaType: "text/html",
    },
    { signal: controller.signal },
  );

  expect(outcome.kind).toBe("failed");

  if (outcome.kind !== "failed") {
    throw new Error("Cancelled HTML conversion did not fail");
  }

  expect(outcome.error).toMatchObject({ name: "AbortError" });
});
