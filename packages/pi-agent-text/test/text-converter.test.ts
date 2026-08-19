import { expect, test } from "vitest";

import { createTextContentConverter, textFromAgentContent } from "pi-agent-text";

const encoder = new TextEncoder();
const converter = createTextContentConverter();

test("preserves strict UTF-8 text, multiline endings, and empty content", async () =>
{
    const value = "first\r\nsecond\nтретья строка\n";

    await expect(converter.tryConvert({ source: "notes", bytes: encoder.encode(value) }, {})).resolves.toEqual({
        kind: "converted",
        content: [{ type: "text", text: value }],
    });
    await expect(converter.tryConvert({ source: "empty", bytes: new Uint8Array(0) }, {})).resolves.toEqual({
        kind: "converted",
        content: [{ type: "text", text: "" }],
    });
});

test("consumes a UTF-8 BOM without changing the remaining text", async () =>
{
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("hello")]);

    await expect(converter.tryConvert({ source: "bom", bytes }, {})).resolves.toEqual({
        kind: "converted",
        content: [{ type: "text", text: "hello" }],
    });
});

test("fails malformed declared text and declines unknown malformed binary", async () =>
{
    const bytes = new Uint8Array([0xc3, 0x28]);
    const declared = await converter.tryConvert(
        { source: "declared", bytes, mediaType: "text/plain; charset=utf-8" },
        {},
    );

    expect(declared.kind).toBe("failed");

    if (declared.kind !== "failed")
    {
        throw new Error("Malformed declared text did not fail");
    }

    expect(declared.error).toMatchObject({ name: "TypeError" });
    expect(String(declared.error)).toContain("valid UTF-8");
    await expect(converter.tryConvert({ source: "unknown", bytes }, {})).resolves.toEqual({ kind: "not-handled" });
});

test.each([
    "application/json",
    "application/problem+json",
    "application/xml",
    "application/atom+xml",
    "application/javascript",
])("recognizes %s as textual content", async (mediaType) =>
{
    await expect(converter.tryConvert({
        source: "response",
        bytes: encoder.encode("{\"ok\":true}"),
        mediaType,
    }, {})).resolves.toMatchObject({ kind: "converted" });
});

test("uses strict UTF-8 as the final fallback for an unknown media type", async () =>
{
    await expect(converter.tryConvert({
        source: "unknown",
        bytes: encoder.encode("plain fallback"),
        mediaType: "application/octet-stream",
    }, {})).resolves.toEqual({
        kind: "converted",
        content: [{ type: "text", text: "plain fallback" }],
    });
});

test("extracts exactly one text block for source writes", () =>
{
    expect(textFromAgentContent([{ type: "text", text: "value" }])).toBe("value");
    expect(() =>
        textFromAgentContent([
            { type: "text", text: "note" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ])
    ).toThrow("exactly one text block");
});
