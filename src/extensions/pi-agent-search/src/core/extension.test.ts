import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderToolCallHeader } from "pi-agent-tool-ui";
import { expect, test } from "vitest";

import { searchCallModel } from "#src/core/extension.js";

const theme = {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  underline: (text: string): string => text,
} as Theme;

const arguments_ = {
  query: "legacyName",
  path: "src",
  include: "**/*.ts",
  exclude: "**/*.test.ts",
  caseSensitive: false,
  wholeWord: true,
  limit: 25,
} as const;

test("summarizes every important search filter on one compact line", () => {
  const rendered = renderToolCallHeader(searchCallModel(arguments_, false), theme, 160).map(
    stripTerminalSequences,
  );

  expect(rendered).toHaveLength(1);
  expect(rendered[0]).toContain('search "legacyName"');
  expect(rendered[0]).toContain("in src");
  expect(rendered[0]).toContain("include **/*.ts");
  expect(rendered[0]).toContain("exclude **/*.test.ts");
  expect(rendered[0]).toContain("whole word");
  expect(rendered[0]).toContain("limit 25");
});

test("shows every passed search argument exactly when expanded", () => {
  const rendered = renderToolCallHeader(searchCallModel(arguments_, true), theme, 64).map(
    stripTerminalSequences,
  );
  const text = rendered.join("\n");

  expect(rendered.every((line) => visibleWidth(line) <= 64)).toBe(true);
  expect(text).toContain('query="legacyName"');
  expect(text).toContain("path=src");
  expect(text).toContain("include=**/*.ts");
  expect(text).toContain("exclude=**/*.test.ts");
  expect(text).toContain("caseSensitive=false");
  expect(text).toContain("wholeWord=true");
  expect(text).toContain("limit=25");
});
