import { expect, test } from "vitest";

import { createPdfContentConverter, isPdf } from "pi-agent-pdf";

import { createPdfFixture } from "./pdf-fixture.js";

const pdf = createPdfFixture(["Hello from PDF", "Second page"]);

test("detects PDF content from its header", () => {
  expect(isPdf(pdf)).toBe(true);
  expect(isPdf(new TextEncoder().encode("prefix\n%PDF-1.7\n"))).toBe(true);
  expect(isPdf(new TextEncoder().encode("plain text"))).toBe(false);
});

test("extracts readable text grouped by page", async () => {
  const outcome = await createPdfContentConverter().tryConvert(
    {
      source: "misleading.txt",
      mediaType: "text/plain",
      bytes: pdf,
    },
    {},
  );

  expect(outcome).toEqual({
    kind: "converted",
    content: [
      {
        type: "text",
        text: "# PDF document\n\n## Page 1 of 2\n\nHello from PDF\n\n## Page 2 of 2\n\nSecond page",
      },
    ],
  });
});

test("accepts Node.js Buffer input from filesystem reads", async () => {
  const outcome = await createPdfContentConverter().tryConvert(
    {
      source: "document.pdf",
      bytes: Buffer.from(pdf),
    },
    {},
  );

  expect(outcome.kind).toBe("converted");
});

test("does not claim unrelated bytes and rejects malformed declared PDFs", async () => {
  const converter = createPdfContentConverter();
  const bytes = new TextEncoder().encode("plain text");

  await expect(converter.tryConvert({ source: "plain.txt", bytes }, {})).resolves.toEqual({
    kind: "not-handled",
  });
  expect(
    (await converter.tryConvert({ source: "broken.pdf", mediaType: "application/pdf", bytes }, {}))
      .kind,
  ).toBe("failed");
  expect(
    (
      await converter.tryConvert(
        { source: "broken.pdf", bytes: new TextEncoder().encode("%PDF-broken") },
        {},
      )
    ).kind,
  ).toBe("failed");
});

test("honors cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await createPdfContentConverter().tryConvert(
    { source: "document.pdf", bytes: pdf },
    {
      signal: controller.signal,
    },
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind === "failed") {
    expect(outcome.error).toMatchObject({ name: "AbortError" });
  }
});
