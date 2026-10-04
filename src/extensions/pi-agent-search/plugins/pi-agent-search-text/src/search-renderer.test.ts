import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { compactSearchDetails, restoreSearchDetails } from "#src/persisted-result.js";
import { createFuzzyPresentation, isSearchToolDetails } from "#src/search-result.js";
import { SearchResultPanel } from "#src/search-renderer.js";

import type { SearchToolDetails } from "#src/search-result.js";
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

test.each([false, true])(
  "keeps original zero separate from possible-name groups (expanded=%s)",
  (expanded) => {
    const details: SearchToolDetails = {
      query: "generateHintStrings",
      matchCount: 0,
      fileCount: 0,
      complete: true,
      files: [],
      fuzzyPresentation: {
        fileCount: 1,
        groups: [
          {
            identifier: "hintStrings",
            files: [
              {
                path: "hints.js",
                link: "file:///workspace/hints.js",
                matchCount: 1,
                lines: [
                  {
                    lineNumber: 886,
                    text: "  hintStrings(linkCount) {",
                    matchCount: 1,
                    ranges: [{ from: 2, to: 13 }],
                  },
                ],
              },
            ],
          },
        ],
      },
      fuzzy: {
        status: "ready",
        message: "Source changed; stable references unavailable.",
        candidates: [
          {
            identifier: "hintStrings",
            kind: "component",
            reason: "remove leading component 'generate'",
            matchCount: 5,
            fileCount: 1,
            selection: {
              kind: "matches",
              truncated: false,
              complete: true,
              matches: [
                {
                  source: "/workspace/hints.js",
                  range: { startLine: 886, endLine: 886, startColumn: 2, endColumn: 13 },
                  matchedText: "hintStrings",
                },
              ],
              all: { line: "SEARCH#AAAA:all:line", match: "SEARCH#AAAA:all:match" },
            },
          },
        ],
      },
    };
    const saved = compactSearchDetails(details, "");
    expect(restoreSearchDetails(saved, "")).toEqual(details);
    expect(isSearchToolDetails(restoreSearchDetails(saved, ""))).toBe(true);
    expect(
      isSearchToolDetails({
        ...details,
        fuzzy: { status: "ready", candidates: [{ identifier: null }] },
      }),
    ).toBe(false);
    const rendered = new SearchResultPanel(details, plainTheme, expanded).render(80);
    const plain = rendered.map(stripTerminalSequences).join("\n");
    expect(plain).toContain("0 exact · 5 fuzzy matches · 1 file");
    expect(plain).toContain("hintStrings(linkCount) {");
    expect(plain).toContain("886");
    expect(rendered.join("\n").replace(/\u001B\[(?!48;5;25m|49m)[\d;]*m/gu, "")).toContain(
      `${SELECTED_BACKGROUND}hintStrings`,
    );
    expect(plain).toContain("Shown 1 of 5");
    expect(plain).toContain("hints.js");
    for (const agentDetail of [
      "No exact matches found",
      "Possible names",
      "Possible name:",
      "not equivalent behavior",
      "Source changed; stable references unavailable.",
      "remove leading component",
      "5 matches in 1 file",
      "Read for all",
      "Exact alternative",
      "SEARCH#",
    ])
      expect(plain).not.toContain(agentDetail);
    expect(rendered.every((line) => visibleWidth(line) === 80)).toBe(true);
  },
);
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
test("marks captured fuzzy totals as lower bounds when a group is incomplete", () => {
  const details: SearchToolDetails = {
    query: "generateHintStrings",
    matchCount: 0,
    fileCount: 0,
    complete: true,
    files: [],
    fuzzy: {
      status: "ready",
      candidates: [
        {
          identifier: "hintStrings",
          kind: "component",
          reason: "remove leading component",
          matchCount: 200,
          fileCount: 1,
          selection: { kind: "matches", truncated: true, complete: false, matches: [] },
        },
      ],
    },
    fuzzyPresentation: { fileCount: 1, groups: [] },
  };
  const plain = new SearchResultPanel(details, plainTheme, false)
    .render(80)
    .map(stripTerminalSequences)
    .join("\n");
  expect(plain).toContain("0 exact · 200+ fuzzy matches · 1+ file");
  expect(plain).not.toContain("Capture limited");
  expect(plain).not.toContain("narrow the scope");
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
test("caps compact search results by rendered height while preserving wrapping", () => {
  const text = `start ${"middle ".repeat(100)}END`;
  const details: SearchToolDetails = {
    query: "start",
    matchCount: 1,
    fileCount: 1,
    complete: true,
    files: [
      {
        path: "long.jsonl",
        link: "file:///workspace/long.jsonl",
        matchCount: 1,
        lines: [
          {
            lineNumber: 8,
            text,
            matchCount: 1,
            ranges: [{ from: 0, to: 5 }],
          },
        ],
      },
    ],
  };
  const compact = new SearchResultPanel(details, plainTheme, false).render(36);
  const expanded = new SearchResultPanel(details, plainTheme, true).render(36);
  const compactText = compact.map(stripTerminalSequences).join("\n");
  const expandedText = expanded.map(stripTerminalSequences).join("\n");

  expect(compact).toHaveLength(14);
  expect(compactText).toContain("start");
  expect(compactText).toContain("output truncated");
  expect(compactText).not.toContain("END");
  expect(expanded.length).toBeGreaterThan(compact.length);
  expect(expandedText).toContain("END");
});
