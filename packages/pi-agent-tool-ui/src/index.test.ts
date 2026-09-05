import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import { preserveEnclosingBackground, ToolCallHeader, type ToolCallHeaderModel } from "./index.js";

import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  underline: (text: string): string => text,
} as Theme;

test("restores an enclosing background only when SGR leaves the background unset", () => {
  const enclosing = "\u001B[48;5;236m";
  const nested = "\u001B[48;5;25m";
  const foregroundWithBackgroundLikeChannels = "\u001B[38;2;40;48;49m";
  const rendered = preserveEnclosingBackground(
    [
      "plain",
      "\u001B[39mforeground reset",
      `${nested}${foregroundWithBackgroundLikeChannels}foreground only`,
      `\u001B[0m${foregroundWithBackgroundLikeChannels}after reset`,
      "\u001B[mfull reset",
      `${nested}nested\u001B[49mouter`,
      "\u001B[0;48;5;25mcompound nested\u001B[49mouter",
      `\u001B[0m${nested}immediate nested`,
    ].join("|"),
    enclosing,
  );

  expect(preserveEnclosingBackground(rendered, enclosing)).toBe(rendered);

  expect(rendered).toBe(
    [
      "plain",
      "\u001B[39mforeground reset",
      `${nested}${foregroundWithBackgroundLikeChannels}foreground only`,
      `\u001B[0m${enclosing}${foregroundWithBackgroundLikeChannels}after reset`,
      `\u001B[m${enclosing}full reset`,
      `${nested}nested\u001B[49m${enclosing}outer`,
      `\u001B[0;48;5;25mcompound nested\u001B[49m${enclosing}outer`,
      `\u001B[0m${nested}immediate nested`,
    ].join("|"),
  );
});

test("keeps a compact call on one line and preserves the end of its target", () => {
  const header = new ToolCallHeader(
    {
      tool: "read",
      primary: {
        text: "src/features/authentication/👩‍💻-extra-long-authentication-source.ts",
        truncate: "start",
      },
      qualifiers: [{ text: "offset 40" }, { text: "limit 30" }, { text: "views lines,anchors" }],
      expanded: false,
    },
    theme,
  );
  const rendered = header.render(52).map(stripTerminalSequences);

  expect(rendered).toHaveLength(1);
  expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(52);
  expect(rendered[0]).toContain("extra-long-authentication-source.ts");

  expect(rendered[0]).toContain("👩‍💻");
  expect(rendered[0]).toContain("… +3");
});

test("renders a partial call before its primary argument becomes a string", () => {
  const partialModel: ToolCallHeaderModel = {
    tool: "search",
    primary: { text: undefined as never },
    expanded: false,
  };

  expect(new ToolCallHeader(partialModel, theme).render(40)).toEqual(["search "]);
});

test("wraps expanded exact arguments within the available width", () => {
  const header = new ToolCallHeader(
    {
      tool: "search",
      primary: { text: '"legacyName"' },
      qualifiers: [{ text: "in src" }, { text: "include **/*.ts" }],
      details: [
        { label: "query", value: '"legacyName"' },
        { label: "path", value: "src" },
        { label: "include", value: "**/*.ts" },
      ],
      expanded: true,
    },
    theme,
  );
  const rendered = header.render(32).map(stripTerminalSequences);

  expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
  expect(rendered.join("\n")).toContain('query="legacyName"');
  expect(rendered.join("\n")).toContain("include=**/*.ts");
});
