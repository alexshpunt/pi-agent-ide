import { expect, test } from "vitest";

import { createImageContentConverter, detectSupportedImageMimeType } from "pi-agent-image";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");

test("classifies supported images from bytes instead of source or media type", () => {
  const webp = Buffer.alloc(12);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");

  expect([
    detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    detectSupportedImageMimeType(png),
    detectSupportedImageMimeType(Buffer.from("GIF89a", "ascii")),
    detectSupportedImageMimeType(webp),
    detectSupportedImageMimeType(createBmp(1, 1)),
  ]).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
});

test("returns native image content for valid bytes under misleading metadata", async () => {
  const converter = createImageContentConverter();
  const outcome = await converter.tryConvert(
    {
      source: "misleading.txt",
      bytes: png,
      mediaType: "text/plain",
    },
    {},
  );

  expect(outcome).toEqual({
    kind: "converted",
    content: [
      { type: "text", text: "Read image [image/png]" },
      { type: "image", data: pngBase64, mimeType: "image/png" },
    ],
  });

  await expect(
    converter.tryConvert(
      {
        source: "plain.txt",
        bytes: new TextEncoder().encode("plain"),
        mediaType: "image/png",
      },
      {},
    ),
  ).resolves.toEqual({ kind: "not-handled" });
});

test("converts BMP to PNG and reports the conversion", async () => {
  const converter = createImageContentConverter();
  const outcome = await converter.tryConvert({ source: "pixel.bmp", bytes: createBmp(1, 1) }, {});

  expect(outcome.kind).toBe("converted");

  if (outcome.kind !== "converted") {
    throw new Error("BMP fixture did not convert");
  }

  expect(outcome.content[0]).toEqual({
    type: "text",
    text: "Read image [image/png]\n[Image converted from image/bmp to image/png.]",
  });
  expect(outcome.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
});

test("rejects animated PNG and malformed recognized images", async () => {
  const converter = createImageContentConverter();
  const animated = Buffer.from(png);
  const idatOffset = animated.indexOf(Buffer.from("IDAT", "ascii"));

  if (idatOffset === -1) {
    throw new Error("PNG fixture does not contain IDAT");
  }

  Buffer.from("acTL", "ascii").copy(animated, idatOffset);

  for (const bytes of [animated, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]) {
    const outcome = await converter.tryConvert({ source: "broken-image", bytes }, {});
    expect(outcome.kind).toBe("failed");
  }

  const normalizationFailure = await converter.tryConvert(
    {
      source: "broken.jpg",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    },
    {},
  );
  expect(normalizationFailure.kind).toBe("failed");
});

test("reports resize hints for images outside Pi dimensions", async () => {
  const converter = createImageContentConverter();
  const outcome = await converter.tryConvert({ source: "wide.bmp", bytes: createBmp(2001, 1) }, {});

  expect(outcome.kind).toBe("converted");

  if (outcome.kind !== "converted" || outcome.content[0].type !== "text") {
    throw new Error("Wide BMP fixture did not convert");
  }

  expect(outcome.content[0].text).toContain("original 2001x1, displayed at 2000x1");
});

function createBmp(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const bytes = Buffer.alloc(54 + pixelBytes);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(pixelBytes, 34);

  for (let offset = 54; offset < bytes.length; offset += 3) {
    bytes[offset + 2] = 0xff;
  }

  return bytes;
}
