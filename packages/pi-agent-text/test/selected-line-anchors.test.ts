import { describe, expect, test } from "vitest";

import { documentLineAnchors, documentSelectedLineAnchors } from "#src/line-anchors.ts";
import { createTextDocument } from "#src/text-document.ts";

function expectSelectedAnchors(content: string, indexes: ReadonlySet<number>): void {
  const { lines } = createTextDocument("fixture.cpp", content);
  const selected = documentSelectedLineAnchors(lines, indexes);
  const all = documentLineAnchors(lines);
  const expected = new Map<number, string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (indexes.has(index)) expected.set(index, all[index] as string);
  }
  expect(selected).toEqual(expected);
}

describe("selected line anchors", () => {
  test("match the complete document's anchors at edges, across repeated lines and blocks", () => {
    const fixtures = [
      "",
      "one",
      "same\nsame\nsame\nsame",
      "\n\n\n",
      "#include <vector>\n\ntemplate <typename T>\nT a() {\n}\n\ntemplate <typename T>\nT b() {\n}\n",
      "}\r\nunique\r\n}\r\n};\r\n\r\n};\r\nlast",
      "a\nrepeated\n}\nrepeated\nb\nrepeated\n}\nrepeated\nc",
    ];
    for (const fixture of fixtures) {
      const { lines } = createTextDocument("fixture.cpp", fixture);
      expectSelectedAnchors(fixture, new Set());
      expectSelectedAnchors(fixture, new Set([0, lines.length - 1]));
      expectSelectedAnchors(fixture, new Set(lines.map((_, index) => index)));
      expectSelectedAnchors(
        fixture,
        new Set(lines.flatMap((_, index) => (index % 2 ? [index] : []))),
      );
    }
  });

  test("ignore indexes outside the document and leave the complete-anchor cache intact", () => {
    const { lines } = createTextDocument("fixture.cpp", "a\nb\na");
    const all = documentLineAnchors(lines);
    expect(documentSelectedLineAnchors(lines, new Set([-1, 1, 3, 1.5, NaN]))).toEqual(
      new Map([[1, all[1]]]),
    );
    expect(documentLineAnchors(lines)).toBe(all);
  });

  test("match complete anchors for deterministic varied selections and line patterns", () => {
    let seed = 0x1912;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const repeated = ["", "}", "};", "  }", "template <typename T>", "x", " "];
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const count = 1 + (random() % 80);
      const parts = Array.from({ length: count }, (_, index) =>
        random() % 3 === 0 ? `unique-${iteration}-${index}` : repeated[random() % repeated.length],
      );
      const content = parts.join(iteration % 2 === 0 ? "\n" : "\r\n");
      const { lines } = createTextDocument("fixture.cpp", content);
      const indexes = new Set(
        lines.flatMap((_, index) => ((random() >>> 16) % 4 === 0 ? [index] : [])),
      );
      expectSelectedAnchors(content, indexes);
    }
  });
});
