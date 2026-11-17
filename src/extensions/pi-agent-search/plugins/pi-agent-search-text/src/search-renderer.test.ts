import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { createFuzzyPresentation } from "#src/search-result.ts";
import { SearchResultPanel } from "#src/search-renderer.ts";

import type { SearchToolDetails } from "#src/search-result.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

initTheme("dark");
const SELECTED_BACKGROUND = "\u001B[48;5;25m";

const RESET_BACKGROUND = "\u001B[49m";

const plainTheme = Object.assign(Object.create(null) as Theme, {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => `${SELECTED_BACKGROUND}${text}${RESET_BACKGROUND}`,
  underline: (text: string): string => text,
});

test("bounds user previews and counts shared files once, including files outside the preview", () => {
  const text = " ".repeat(10000) + "hintStrings" + " ".repeat(10000);
  const matches = Array.from({ length: 5 }, (_, index) => ({
    source: index === 4 ? "/workspace/other.js" : "/workspace/hints.js",
    lineNumber: index + 1,
    lineText: text,
    matchedText: "hintStrings",
    startColumn: 10000,
    endColumn: 10011,
  }));
  const first = {
    identifier: "hintStrings",
    kind: "component" as const,
    reason: "remove leading component",
    matches,
    complete: true,
  };
  const preview = createFuzzyPresentation(
    [first, { ...first, identifier: "generateHintString" }],
    "/workspace",
  );
  expect(preview.fileCount).toBe(2);
  expect(preview.groups[0]?.files[0]?.lines).toHaveLength(3);
  for (const group of preview.groups)
    for (const file of group.files)
      for (const line of file.lines) {
        expect(line.text.length).toBeLessThan(220);
        expect(line.text.slice(line.ranges[0]?.from, line.ranges[0]?.to)).toBe("hintStrings");
      }
});
test("wraps a full search match line with one aligned line-number gutter", () => {
  const text = `prefix ${"alpha ".repeat(5)}MATCH ${"https://example.com/".repeat(8)} suffix`;
  const matchStart = text.indexOf("MATCH");
  const details: SearchToolDetails = {
    query: "MATCH",
    matchCount: 1,
    fileCount: 1,
    complete: true,
    files: [
      {
        path: "notes.md",
        link: "file:///workspace/notes.md",
        matchCount: 1,
        lines: [
          {
            lineNumber: 42,
            text,
            matchCount: 1,
            ranges: [{ from: matchStart, to: matchStart + 5 }],
          },
        ],
      },
    ],
  };
  const panel = new SearchResultPanel(details, plainTheme, true);
  const rendered = panel.render(36);
  const plain = rendered.map(stripTerminalSequences);
  const body = plain.slice(2, -1);
  const first = body[0] ?? "";

  expect(body.length).toBeGreaterThan(1);
  expect(body.every((line) => visibleWidth(line) === 36)).toBe(true);
  expect(rendered.join("\n")).toMatch(/\u001B\[48;5;25m(?:\u001B\[[\d;]+m)*MATCH/u);
  expect(first).toMatch(/^│\s+42\s+│/u);
  expect(body.slice(1).every((line) => !/^│\s+42\s+│/u.test(line))).toBe(true);
  expect(plain.join("\n")).toContain("prefix");
  expect(plain.join("\n")).toContain("MATCH");
  expect(plain.join("\n")).toContain("https://example.com/");
  expect(plain.join("\n")).toContain("suffix");
});

test.each([false, true])(
  "shows a bounded preview around a distant match (expanded=%s)",
  (expanded) => {
    const text = "before ".repeat(3000) + "MATCH" + " after".repeat(3000);
    const from = text.indexOf("MATCH");
    const details: SearchToolDetails = {
      query: "MATCH",
      matchCount: 1,
      fileCount: 1,
      complete: true,
      files: [
        {
          path: "large.txt",
          link: "file:///large.txt",
          matchCount: 1,
          lines: [{ lineNumber: 1, text, matchCount: 1, ranges: [{ from, to: from + 5 }] }],
        },
      ],
    };
    const rendered = new SearchResultPanel(details, plainTheme, expanded).render(40);
    const plain = rendered.map(stripTerminalSequences).join("\n");
    expect(rendered.length).toBeLessThan(30);
    expect(rendered.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(plain).toContain("MATCH");
    expect(plain).toContain("…");
    expect(rendered.join("\n")).toContain(`${SELECTED_BACKGROUND}MATCH`);
    expect(details.files[0]?.lines[0]?.text).toBe(text);
  },
);
test("keeps expanded compacted search results bounded", () => {
  const details: SearchToolDetails = {
    query: "needle",
    matchCount: 100,
    fileCount: 1,
    complete: true,
    files: [
      {
        path: "large.txt",
        link: "file:///workspace/large.txt",
        matchCount: 100,
        uniqueLineCount: 2,
        groups: [
          { text: "same needle", matchCount: 80 },
          { text: "other needle", matchCount: 20 },
        ],
        lines: [],
      },
    ],
  };

  const rendered = new SearchResultPanel(details, plainTheme, true).render(80);

  expect(rendered).toHaveLength(6);
  expect(rendered.every((line) => visibleWidth(line) === 80)).toBe(true);
});
