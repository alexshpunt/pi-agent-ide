import { expect, test } from "vitest";

import { planSearchPresentation } from "#src/search-presentation.js";

import type { TextSearchMatch } from "#src/search-session.js";

function matches(source: string, count: number, lineText = "needle"): TextSearchMatch[] {
  return Array.from({ length: count }, (_, index) => ({
    source,
    lineNumber: index + 1,
    startColumn: 0,
    endColumn: 6,
    matchedText: "needle",
    lineText,
  }));
}

test("keeps every match when the presentation budget is not exceeded", () => {
  const input = [...matches("/repo/a.ts", 30), ...matches("/repo/b.ts", 20)];

  const plan = planSearchPresentation(input, 50);

  expect(plan.files.every((file) => file.kind === "detailed")).toBe(true);
  expect(plan.files.flatMap((file) => (file.kind === "detailed" ? file.matches : []))).toHaveLength(
    50,
  );
});

test("compacts the noisiest files and preserves complete smaller files", () => {
  const input = [...matches("/repo/noisy.ts", 100), ...matches("/repo/useful.ts", 5)];

  const plan = planSearchPresentation(input, 50);

  expect(plan.files).toEqual([
    {
      kind: "compacted",
      source: "/repo/noisy.ts",
      matchCount: 100,
      uniqueLineCount: 1,
      groups: [],
    },
    {
      kind: "detailed",
      source: "/repo/useful.ts",
      matches: input.slice(100),
    },
  ]);
});

test("groups repeated lines in one noisy file without consuming one row per match", () => {
  const input = [
    ...matches("/repo/large.txt", 80, "same needle"),
    ...matches("/repo/large.txt", 20, "other needle"),
  ];

  expect(planSearchPresentation(input, 50).files).toEqual([
    {
      kind: "compacted",
      source: "/repo/large.txt",
      matchCount: 100,
      uniqueLineCount: 2,
      groups: [
        { text: "same needle", matchCount: 80 },
        { text: "other needle", matchCount: 20 },
      ],
    },
  ]);
});

test("counts compact summaries and details against the same item budget", () => {
  const input = Array.from({ length: 18 }, (_, index) => matches(`/repo/${index}.ts`, 4)).flat();
  const plan = planSearchPresentation(input, 1);
  expect(plan.files).toHaveLength(1);
});

test("bounds the reported 10114-match search across 1725 generated files", () => {
  const input = Array.from({ length: 1725 }, (_, index) =>
    matches(`/repo/generated/${index.toString().padStart(4, "0")}.ts`, index < 1489 ? 6 : 5),
  ).flat();
  expect(input).toHaveLength(10114);
  const plan = planSearchPresentation(input, 80);
  const items = plan.files.reduce(
    (count, file) =>
      count + (file.kind === "detailed" ? file.matches.length : 1 + file.groups.length),
    0,
  );
  expect(items).toBeLessThanOrEqual(80);
});
test("caps unique groups by the presentation budget", () => {
  const input = Array.from({ length: 60 }, (_, index) =>
    matches("/repo/large.txt", 1, `needle ${String(index)}`),
  ).flat();

  const [file] = planSearchPresentation(input, 50).files;

  expect(file?.kind).toBe("compacted");
  expect(file?.kind === "compacted" ? file.groups : []).toHaveLength(49);
  expect(file?.kind === "compacted" ? file.uniqueLineCount : 0).toBe(60);
});
