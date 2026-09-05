import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { SearchResultPanel } from "#src/search-renderer.js";

import type { SearchToolDetails } from "#src/search-result.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

const SELECTED_BACKGROUND = "\u001B[48;5;25m";

const RESET_BACKGROUND = "\u001B[49m";

const plainTheme = Object.assign(Object.create(null) as Theme, {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => `${SELECTED_BACKGROUND}${text}${RESET_BACKGROUND}`,
  underline: (text: string): string => text,
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
  expect(rendered.join("\n")).toContain("\u001B[48;5;25mMATCH");
  expect(first).toMatch(/^│\s+42\s+│/u);
  expect(body.slice(1).every((line) => !/^│\s+42\s+│/u.test(line))).toBe(true);
  expect(plain.join("\n")).toContain("prefix");
  expect(plain.join("\n")).toContain("MATCH");
  expect(plain.join("\n")).toContain("https://example.com/");
  expect(plain.join("\n")).toContain("suffix");
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
