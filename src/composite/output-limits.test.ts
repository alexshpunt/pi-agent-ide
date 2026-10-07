import { createCanvas, loadImage } from "@napi-rs/canvas";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { limitIdeOutput } from "./output-limits.js";
import {
  captureImages,
  selectImage,
  validateVisionOptions,
} from "#src/plugins/pi-agent-ide-vision/src/vision.js";

for (const shape of ["many-lines", "long-unicode", "many-blocks"] as const) {
  test(`bounds ${shape} across the whole payload`, async () => {
    const payload = shape === "many-lines" ? "line\n".repeat(4000) : "😀".repeat(30000);
    const blocks =
      shape === "many-blocks"
        ? Array.from({ length: 100 }, () => ({ type: "text" as const, text: "x".repeat(1024) }))
        : [{ type: "text" as const, text: payload }];
    const result = await limitIdeOutput(blocks);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(result.text).not.toContain("�");
    expect(result.notices.join("\n")).toContain("[Output truncated:");
  });
}

for (const size of [0, 1, DEFAULT_MAX_BYTES - 1, DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES + 1]) {
  test(`preserves useful text at the ${size}-byte boundary`, async () => {
    const text = "x".repeat(size);
    const result = await limitIdeOutput([{ type: "text", text }]);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    if (size <= DEFAULT_MAX_BYTES) {
      expect(result.text).toBe(text);
      expect(result.notices).toEqual([]);
    } else expect(result.notices).toHaveLength(1);
  });
}

for (const lines of [DEFAULT_MAX_LINES - 1, DEFAULT_MAX_LINES, DEFAULT_MAX_LINES + 1]) {
  test(`shares the ${lines}-line boundary across text blocks`, async () => {
    const blocks = Array.from({ length: lines }, () => ({ type: "text" as const, text: "line" }));
    const result = await limitIdeOutput(blocks);
    expect(result.text.split("\n")).toHaveLength(Math.min(lines, DEFAULT_MAX_LINES));
    expect(result.notices.length).toBe(Number(lines > DEFAULT_MAX_LINES));
  });
}
test("keeps a useful UTF-8 prefix when the first output line alone exceeds the budget", async () => {
  const result = await limitIdeOutput([
    { type: "text", text: "READ_FAILED: " + "😀".repeat(30000) },
  ]);
  expect(result.text).toMatch(/^READ_FAILED: 😀+/u);
  expect(Buffer.byteLength(result.text)).toBeGreaterThan(DEFAULT_MAX_BYTES - 4);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(result.text).not.toContain("�");
  expect(result.notices).toHaveLength(1);
});
test("re-encodes oversized image bytes without losing a valid image", async () => {
  const png = await createCanvas(10, 10).encode("png");
  const padded = Buffer.concat([png, Buffer.alloc(21 * 1024 * 1024)]);
  const result = await limitIdeOutput([
    { type: "image", data: padded.toString("base64"), mimeType: "image/png" },
  ]);
  const image = result.images.find((block) => block.type === "image");
  expect(image).toBeDefined();
  if (!image) throw new Error("Image was lost");
  expect(Buffer.byteLength(image.data, "base64")).toBeLessThanOrEqual(20 * 1024 * 1024);
  const decoded = await loadImage(Buffer.from(image.data, "base64"));
  expect([decoded.width, decoded.height]).toEqual([10, 10]);
});
test("saves the complete useful text before truncation and leaves metadata outside the file", async () => {
  const full = "row\n".repeat(2200) + "FINAL_ROW";
  const metadata = "\n\n[Existing continuation notice.]";
  const saved: string[] = [];
  const result = await limitIdeOutput(
    [{ type: "text", text: full + metadata }],
    metadata,
    async (text) => {
      saved.push(text);
      return "/tmp/full-output.txt";
    },
  );
  expect(saved.length).toBe(1);
  expect(saved[0] === full).toBe(true);
  expect(result.fullOutput).toBe("/tmp/full-output.txt");
  expect(result.text).not.toContain("FINAL_ROW");
  expect(result.metadataSuffix).toBe(metadata);
  expect(result.notices.join("\n")).toContain("/tmp/full-output.txt");
});

test("does not save output that fits the useful budget", async () => {
  const saved: string[] = [];
  const result = await limitIdeOutput([{ type: "text", text: "small" }], "", async (text) => {
    saved.push(text);
    return "/tmp/unused.txt";
  });
  expect(saved).toEqual([]);
  expect(result.fullOutput).toBeUndefined();
});
test("leaves existing Read metadata outside the useful-content budget", async () => {
  const payload = "x".repeat(DEFAULT_MAX_BYTES);
  const metadata = "\n\n[Existing continuation notice.]";
  const result = await limitIdeOutput([{ type: "text", text: payload + metadata }], metadata);
  expect(result.text).toBe(payload);
  expect(result.metadataSuffix).toBe(metadata);
  expect(result.notices).toEqual([]);
});

test("keeps notices from multiple Read resources after the shared useful payload", async () => {
  const notice = "\n\n[" + "metadata ".repeat(200) + "]";
  const result = await limitIdeOutput(
    [
      { type: "text", text: "a".repeat(30000) + notice },
      { type: "text", text: "b".repeat(20000) + notice },
    ],
    [notice, notice],
  );
  expect(result.text).toBe("a".repeat(30000) + "\n" + "b".repeat(20000));
  expect(result.metadataSuffix).toBe(notice + notice);
  expect(result.notices).toEqual([]);
});
for (const count of [1, 5, 20, 25]) {
  test(`shares pixel and frame budgets across ${count} images`, async () => {
    const image = await createCanvas(2100, 2100).encode("png");
    const result = await limitIdeOutput(
      Array.from({ length: count }, () => ({
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/png",
      })),
    );
    const images = result.images.filter((block) => block.type === "image");
    expect(images.length).toBe(Math.min(count, 20));
    const sizes = await Promise.all(
      images.map(async (block) => {
        const decoded = await loadImage(Buffer.from(block.data, "base64"));
        return decoded.width * decoded.height;
      }),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(4_000_000);
    expect(
      images.reduce((bytes, block) => bytes + Buffer.byteLength(block.data, "base64"), 0),
    ).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(result.notices.join("\n")).toContain("resized");
  });
}

for (const scale of [1, 0.5]) {
  for (const crop of [false, true]) {
    test(`bounds grid cells after crop=${crop} and scale=${scale}`, async () => {
      const png = await createCanvas(640, 400).encode("png");
      const width = Math.round(640 * (crop ? 0.5 : 1) * scale);
      const height = Math.round(400 * (crop ? 0.5 : 1) * scale);
      for (const cellSize of [1, 200, 5000]) {
        const columns = Math.ceil(width / cellSize);
        const rows = Math.ceil(height / cellSize);
        for (const cellIndex of [undefined, 0, columns * rows - 1, columns * rows]) {
          const options = validateVisionOptions({
            mode: "image",
            scale,
            cellSize,
            cellIndex,
            ...(crop ? { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } : {}),
          });
          if (cellIndex === columns * rows) {
            await expect(selectImage(png, options)).rejects.toThrow("exceeds");
            continue;
          }
          const blocks = await captureImages(async () => png, options);
          const result = await limitIdeOutput(blocks);
          expect(result.images).toHaveLength(1);
          const image = result.images.find((block) => block.type === "image");
          if (!image) throw new Error("Image was lost");
          const actual = await loadImage(Buffer.from(image.data, "base64"));
          expect(actual.width).toBe(
            Math.min(cellSize, width - ((cellIndex ?? 0) % columns) * cellSize),
          );
          expect(actual.height).toBe(
            Math.min(cellSize, height - Math.floor((cellIndex ?? 0) / columns) * cellSize),
          );
        }
      }
    });
  }
}
test("shares the media budget after a maximum-length sequence capture", async () => {
  const png = await createCanvas(640, 400).encode("png");
  const blocks = await captureImages(async () => png, {
    mode: "sequence",
    durationSeconds: 0.019,
    intervalSeconds: 0.001,
    scale: 1,
  });
  expect(blocks).toHaveLength(20);
  const result = await limitIdeOutput(blocks);
  expect(result.images).toHaveLength(20);
  const pixels = await Promise.all(
    result.images
      .filter((block) => block.type === "image")
      .map(async (block) => {
        const image = await loadImage(Buffer.from(block.data, "base64"));
        return image.width * image.height;
      }),
  );
  expect(pixels.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(4_000_000);
});
test("does not let an invalid image break the tool result", async () => {
  const result = await limitIdeOutput([
    { type: "image", data: "broken", mimeType: "image/png" },
    { type: "text", text: "Useful result" },
  ]);
  expect(result.text).toBe("Useful result");
  expect(result.images).toEqual([]);
  expect(result.notices.join("\n")).toContain("could not be decoded");
});
