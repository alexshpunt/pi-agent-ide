import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { ResultPanel, sourceRows } from "./result-panel.js";

const theme = Object.assign(Object.create(null) as Theme, {
  bold: (s: string) => s,
  underline: (s: string) => s,
  fg: (_color: string, s: string) => s,
  bg: (_color: string, s: string) => `\u001B[48;5;25m${s}\u001B[49m`,
});

const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("keeps syntax colors and exact selection backgrounds across wrapping and multiline comments", () => {
  initTheme("dark");
  const code = ["/* comment", "inside comment", "*/ function task() { return 42; }"];
  const colored = highlightCode(code.join("\n"), "javascript");
  const keyword = colored[2]?.match(/\u001B\[[\d;]+m(?=function)/u)?.[0];
  expect(keyword).toBeDefined();
  const rows = sourceRows(
    code.map((text, index) => ({
      source: "/work/task.js",
      label: "task.js",
      lineNumber: index + 1,
      text,
      ranges: index === 2 ? [{ from: text.indexOf("42"), to: text.indexOf("42") + 2 }] : [],
    })),
  );
  const output = new ResultPanel({ summary: "1 selection", rows }, theme, true).render(42);
  const rendered = output.join("\n");
  expect(rendered).toContain(`${keyword}function`);
  expect(rendered).toContain(colored[1]);
  expect(plain(output)).toContain("inside comment");
  expect(output.every((line) => visibleWidth(line) === 42)).toBe(true);
  const start = rendered.indexOf("\u001B[48;5;25m", rendered.indexOf("task.js") + 7);
  const selected = rendered.slice(start, rendered.indexOf("\u001B[49m", start));
  expect(selected).toContain("42");
  expect(selected).not.toMatch(/\u001B\[(?:0|49)?m(?!\u001B\[48;5;)/u);
});

test("restores the selected header background after nested full resets", () => {
  const resettingTheme = Object.assign(Object.create(null) as Theme, {
    bold: (s: string) => s + "\u001B[0m",
    underline: (s: string) => s + "\u001B[m",
    fg: (_color: string, s: string) => s + "\u001B[39m",
    bg: (_color: string, s: string) => "\u001B[48;5;25m" + s + "\u001B[49m",
  });
  const model = {
    summary: "1 file",
    rows: [{ kind: "source" as const, label: "src/a.ts", link: "file:///src/a.ts" }],
  };
  const header = new ResultPanel(model, resettingTheme, false).render(36)[1] ?? "";
  expect(header).toContain("\u001B[0m\u001B[48;5;25m");
  expect(header).toContain("\u001B[m\u001B[48;5;25m");
  expect(visibleWidth(header)).toBe(36);
});

test("groups exact code highlights by source, with one gutter per wrapped line", () => {
  const rows = sourceRows([
    {
      source: "/work/a.ts",
      label: "a.ts",
      link: "file:///work/a.ts",
      lineNumber: 4,
      text: "😀 before needle after",
      ranges: [{ from: 10, to: 16 }],
    },
    {
      source: "/work/a.ts",
      label: "a.ts",
      link: "file:///work/a.ts",
      lineNumber: 4,
      text: "😀 before needle after",
      ranges: [{ from: 10, to: 16 }],
    },
  ]);
  const output = new ResultPanel({ summary: "2 selections in 1 file", rows }, theme, true).render(
    24,
  );
  expect(plain(output).match(/a\.ts/gu)).toHaveLength(1);
  expect(plain(output).match(/4 │/gu)).toHaveLength(1);
  expect(output.join("\n")).toContain("\u001B[48;5;25mneedle");
  expect(output.every((line) => visibleWidth(line) === 24)).toBe(true);
});

test("uses the same frame for path-only and readonly record results", () => {
  for (const model of [
    {
      summary: "1 file",
      rows: [{ kind: "source" as const, label: "lib/a.ts", link: "file:///work/lib/a.ts" }],
    },
    { summary: "1 process shown", rows: [{ kind: "note" as const, text: "42 node worker" }] },
  ]) {
    const result = plain(new ResultPanel(model, theme, false).render(40));
    expect(result).toContain("╭─");
    expect(result).toContain("╰");
    expect(result).not.toContain("undefined");
  }
});

test("keeps metadata expanded-only, visible omission, and truthful empty/incomplete summaries", () => {
  const model = {
    summary: "0 selections · incomplete",
    rows: [
      { kind: "note" as const, text: "No enclosing function" },
      { kind: "note" as const, text: "1:4–3:1 · 2 origins", expandedOnly: true },
    ],
  };
  expect(plain(new ResultPanel(model, theme, false).render(60))).not.toContain("origins");
  expect(plain(new ResultPanel(model, theme, true).render(60))).toContain("2 origins");
  const long = {
    summary: "1 match",
    rows: [{ kind: "line" as const, lineNumber: 1, text: "long ".repeat(100), ranges: [] }],
  };
  const compact = new ResultPanel(long, theme, false).render(30);
  expect(compact).toHaveLength(14);
  expect(plain(compact)).toContain("output truncated");
  for (const width of [1, 2, 3, 4, 8])
    expect(
      new ResultPanel(long, theme, false)
        .render(width)
        .every((line) => visibleWidth(line) <= width),
    ).toBe(true);
});

test("sanitizes source text and links without modifying the presentation model", () => {
  const text = "prefix\u001B[2J\tneedle";
  const model = {
    summary: "1 match",
    rows: [
      { kind: "source" as const, label: "bad\u001B[2J.ts", link: "file:///bad\u0007.ts" },
      { kind: "line" as const, lineNumber: 1, text, ranges: [{ from: 12, to: 18 }] },
    ],
  };
  const rendered = new ResultPanel(model, theme, true).render(80).join("\n");
  expect(rendered).not.toContain("\u001B[2J");
  expect(rendered).not.toContain("\u001B]8;;file:///bad");
  expect(model.rows[1]?.text).toBe(text);
});
