import { expect, test } from "vitest";
import { comparisonText } from "#src/core/diff-tool.js";

test("comparison text retains every resolved resource without parsing presentation", () => {
  const value = comparisonText(
    {
      kind: "resources",
      resources: [
        {
          kind: "text",
          source: "one",
          content: "a\r\n",
          lines: [],
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
        {
          kind: "text",
          source: "two",
          content: "b",
          lines: [],
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
      ],
    },
    "selection",
  );
  expect(value.content).toBe("a\r\n\nb");
  expect(value.sources).toEqual(["one", "two"]);
});

test("comparison refuses native image data rather than treating it as empty text", () => {
  expect(() =>
    comparisonText(
      {
        kind: "native",
        source: "image.png",
        blocks: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      },
      "image.png",
    ),
  ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_CONTENT" }));
});
