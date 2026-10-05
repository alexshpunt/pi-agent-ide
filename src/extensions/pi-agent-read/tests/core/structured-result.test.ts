import { MAX_STRUCTURED_BYTES } from "pi-agent-resource";
import { expect, test } from "vitest";
import { structuredRead } from "#src/core/tools/read/structured-result.js";

test("native image bytes stay in content instead of overflowing the private Read record", () => {
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    data: "A".repeat(MAX_STRUCTURED_BYTES + 1),
  };
  const result = structuredRead({
    content: [image],
    script: { kind: "native", source: "image.png", blocks: [image] },
    details: { source: "image.png", resolvedBy: "image" },
  });
  expect(result.isError).toBe(false);
  expect(result.content[0]).toBe(image);
  expect(result.structuredContent).toEqual({
    status: "success",
    data: {
      kind: "native",
      source: "image.png",
      truncated: false,
      blocks: [{ type: "image", mimeType: "image/png" }],
    },
    errors: [],
  });
});
