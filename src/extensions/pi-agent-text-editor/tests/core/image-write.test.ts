import path from "node:path";
import { expect, test } from "vitest";
import { ResultImageStore } from "pi-agent-resource";
import { planImageWrite } from "#src/core/image-write.ts";

const cwd = path.resolve("/workspace");
const pixel = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const id = "0b8f3f5e-6c1a-4d3e-9f2a-1c2d3e4f5a6b";

function store(): ResultImageStore {
  const images = new ResultImageStore();
  images.keep(`<system-result note="x"><uuid>${id}</uuid></system-result>\n`, cwd, [pixel]);
  return images;
}

test("text content is never an image, even when it names an image result", async () => {
  for (const content of [id, `RESULT#${id}`, '{"type": "image", "data": "aW1hZ2U="}'])
    expect(await planImageWrite("note.txt", undefined, content, store(), cwd)).toBeUndefined();
});

test("image takes an issued reference or a Codemode image value", async () => {
  const bytes = Buffer.from(pixel.data, "base64");
  for (const image of [id, `RESULT#${id}`, pixel, { type: "images", images: [pixel] }])
    expect(await planImageWrite("shot.png", image, undefined, store(), cwd)).toEqual([
      { source: path.join(cwd, "shot.png"), bytes },
    ]);
});

test("Write needs exactly one of content and image", async () => {
  await expect(
    planImageWrite("note.txt", undefined, undefined, store(), cwd),
  ).rejects.toMatchObject({ code: "WRITE_CONTENT_MISSING" });
  await expect(planImageWrite("shot.png", id, "", store(), cwd)).rejects.toThrow("not both");
});

test("image refuses text that is not an image result", async () => {
  for (const image of ["hello", "0b8f3f5e-0000-4000-8000-000000000000"])
    await expect(planImageWrite("shot.png", image, undefined, store(), cwd)).rejects.toThrow(
      "image must be",
    );
});
