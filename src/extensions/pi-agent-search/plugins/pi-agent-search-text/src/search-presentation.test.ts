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

test("caps unique groups by the presentation budget", () => {
  const input = Array.from({ length: 60 }, (_, index) =>
    matches("/repo/large.txt", 1, `needle ${String(index)}`),
  ).flat();

  const [file] = planSearchPresentation(input, 50).files;

  expect(file?.kind).toBe("compacted");
  expect(file?.kind === "compacted" ? file.groups : []).toHaveLength(50);
  expect(file?.kind === "compacted" ? file.uniqueLineCount : 0).toBe(60);
});
