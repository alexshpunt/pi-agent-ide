import { describe, expect, test } from "vitest";

import { isLineAnchor, lineAnchors, linesWithAnchor } from "#src/line-anchors.ts";

const sampling = [
  "// Sampling",
  "template <typename T>",
  "T lerp(T a, T b) { return a + b; }",
  "}",
  "// Mixing",
  "template <typename T>",
  "T mix(T a, T b) { return a * b; }",
  "}",
];

function anchorOf(lines: readonly string[], text: string, occurrence = 1): string {
  const index = lines.flatMap((line, at) => (line === text ? [at] : []))[occurrence - 1];
  if (index === undefined) throw new Error(`no line ${text}`);
  return lineAnchors(lines)[index] as string;
}

describe("line anchors", () => {
  test("are seven characters of one alphabet", () => {
    for (const anchor of lineAnchors(sampling)) {
      expect(anchor).toMatch(/^[0-9A-HJKMNP-TV-Z]{7}$/);
      expect(isLineAnchor(anchor)).toBe(true);
    }
    expect(isLineAnchor("K7M2QX")).toBe(false);
    expect(isLineAnchor("K7M2QX45")).toBe(false);
    expect(isLineAnchor("k7m2qx4")).toBe(false);
  });

  test("name a unique line by its text alone, wherever it sits", () => {
    const anchor = anchorOf(sampling, "T lerp(T a, T b) { return a + b; }");
    const shifted = ["one", "two", "three", ...sampling, "four"];
    expect(linesWithAnchor(lineAnchors(shifted), anchor)).toEqual([6]);
  });

  test("tell repeated lines apart by landmark and occurrence", () => {
    const anchors = lineAnchors(sampling);
    expect(new Set(anchors).size).toBe(sampling.length);
  });

  test("keep a repeated line's anchor when lines change outside its stretch", () => {
    const anchor = anchorOf(sampling, "}", 2);
    const edited = [
      "// Added above",
      "}",
      "template <typename T>",
      ...sampling.slice(0, 4),
      "// Mixing",
      "template <typename T>",
      "T mix(T a, T b) { return a * b; }",
      "}",
      "// Added below",
    ];
    expect(linesWithAnchor(lineAnchors(edited), anchor)).toEqual([edited.length - 1]);
  });

  test("move a repeated line's anchor with its landmark, not with the file", () => {
    const first = anchorOf(sampling, "template <typename T>", 1);
    const second = anchorOf(sampling, "template <typename T>", 2);
    expect(first).not.toBe(second);
    const shifted = ["a", "b", ...sampling];
    expect(linesWithAnchor(lineAnchors(shifted), first)).toEqual([4]);
    expect(linesWithAnchor(lineAnchors(shifted), second)).toEqual([8]);
  });

  test("fall back to the start of the file when no unique line is above", () => {
    const lines = ["x", "x", "x", "x"];
    const anchors = lineAnchors(lines);
    expect(new Set(anchors).size).toBe(4);
    // The occurrence number from the top, like a line number: an inserted copy shifts it.
    const inserted = ["x", ...lines];
    expect(linesWithAnchor(lineAnchors(inserted), anchors[1] as string)).toEqual([2]);
  });

  test("stop naming a line whose own text changed", () => {
    const anchor = anchorOf(sampling, "T mix(T a, T b) { return a * b; }");
    const edited = sampling.map((line) => line.replace("a * b", "a - b"));
    expect(linesWithAnchor(lineAnchors(edited), anchor)).toEqual([]);
  });

  test("stop naming a unique line once a copy of it appears", () => {
    const anchor = anchorOf(sampling, "// Mixing");
    const edited = [...sampling, "// Mixing"];
    expect(linesWithAnchor(lineAnchors(edited), anchor)).toEqual([]);
  });

  test("rarely share an anchor between different lines of a large file", () => {
    const lines = Array.from({ length: 26_000 }, (_, index) =>
      index % 2 === 0 ? `line ${index}` : index % 4 === 1 ? "}" : "template <typename T>",
    );
    const anchors = lineAnchors(lines);
    const unique = lines.flatMap((line, index) =>
      line.startsWith("line ") ? [anchors[index]] : [],
    );
    expect(new Set(unique).size).toBe(unique.length);
  });

  test("return the same array for the same list", () => {
    expect(lineAnchors(sampling)).toBe(lineAnchors(sampling));
  });
});
