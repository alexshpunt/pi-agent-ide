import { initTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  applyFrameRows,
  renderApplyResult,
  createApplyCallRenderer,
} from "#src/core/apply/renderer.js";

initTheme("dark", false);
const theme = Object.assign(Object.create(null) as Theme, {
  fg: (_color: ThemeColor, value: string) => value,
  bold: (value: string) => value,
  underline: (value: string) => value,
  getBgAnsi: () => "\u001b[48;2;10;20;30m",
});

test("Apply preserves completed code rows when its result is appended", () => {
  const source = 'await read({path: "a.ts"});\n';
  const pending = applyFrameRows(source, theme, 60, "call", true, "javascript");
  const complete = applyFrameRows(source, theme, 60, "call", false, "javascript");
  expect(complete).toEqual(pending.slice(0, -1));
  const growing = applyFrameRows(
    source + "await result(1);",
    theme,
    60,
    "call",
    true,
    "javascript",
  );
  expect(growing.slice(0, 2)).toEqual(pending.slice(0, 2));
  for (const width of [1, 4, 5, 20, 60]) {
    const lines = applyFrameRows(
      'const value = "a very long string with spaces";',
      theme,
      width,
      "call",
      true,
      "javascript",
    );
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});

test("Apply restores its enclosing background after nested resets", () => {
  const resetTheme = Object.assign(Object.create(null) as Theme, {
    fg: (_color: ThemeColor, value: string) => `\u001b[31m${value}\u001b[0m`,
    getBgAnsi: () => "\u001b[48;2;10;20;30m",
  });
  const rows = applyFrameRows(
    "a long result that wraps across rows",
    resetTheme,
    20,
    "result",
    true,
  );
  for (const row of rows) {
    const body = row.slice(0, -4);
    expect(body.replaceAll("\u001b[0m\u001b[48;2;10;20;30m", "")).not.toContain("\u001b[0m");
    expect(visibleWidth(row)).toBeLessThanOrEqual(20);
  }
});

test("Apply expands result content without changing the stored result", () => {
  const source = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n");
  const result = { content: [], details: { display: { blocks: [{ text: source }] } } };
  const context = { state: {}, isError: false } as Parameters<typeof renderApplyResult>[3];
  const compact = renderApplyResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(60);
  const expanded = renderApplyResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    context,
  ).render(60);
  expect(compact.length).toBeLessThan(expanded.length);
  expect(expanded.join("\n")).toContain("line-39");
  expect(compact.join("\n")).not.toContain("line-39");
  expect(result.details.display.blocks[0]?.text).toBe(source);
});

test("Apply does not leave blank rows after its last read panel", () => {
  const context = { state: {}, isError: false } as Parameters<typeof renderApplyResult>[3];
  const rows = renderApplyResult(
    { content: [], details: { display: { blocks: [{ text: "first" }, { text: "second" }] } } },
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(60);
  expect(rows.at(-2)).toContain("╰");
  expect(rows.at(-1)).toContain("╰");
});

test("mixed preview stays short while a large argument streams and expansion keeps source", () => {
  const renderCall = createApplyCallRenderer((call) => `write ${call.path?.text ?? "…"}`);
  const context = { state: {}, expanded: false } as Parameters<typeof renderCall>[2];
  const prefix = 'write({path:"a.txt", content:"';
  const source = prefix + "z".repeat(4000) + 'SENTINEL"});';
  const first = renderCall({ source: prefix }, theme, context).render(60);
  const pending = renderCall({ source: source.slice(0, -4) }, theme, context).render(60);
  expect(pending).toEqual(first);
  expect(renderCall({ source }, theme, context).render(60).length).toBeLessThan(8);
  const expanded = renderCall({ source }, theme, { ...context, expanded: true }).render(60);
  expect(expanded.join("\n")).toContain("SENTINEL");
  expect(source.endsWith('SENTINEL"});')).toBe(true);
});

test("mixed substitution uses the formatted display copy before splitting calls", () => {
  const renderCall = createApplyCallRenderer((call) => call.name);
  const context = {
    state: { displaySource: 'replace({path:"a",text:"b"});\ninsert({path:"a",text:"c"});' },
    expanded: false,
  } as Parameters<typeof renderCall>[2];
  const rows = renderCall(
    { source: 'replace({path:"a",text:"b"});insert({path:"a",text:"c"});' },
    theme,
    context,
  ).render(80);
  expect(rows.findIndex((row) => row.includes("replace"))).toBeLessThan(
    rows.findIndex((row) => row.includes("insert")),
  );
});
