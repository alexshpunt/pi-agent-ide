import { initTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  applyFrameRows,
  compactApplyPreview,
  renderApplyResult,
  createApplyCallRenderer,
  createApplyDisplay,
  createApplyResultRenderer,
} from "#src/core/apply/renderer.js";
import { ApplyResults } from "#src/core/apply/results.js";

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

test("Apply shows changed files when a large mutation panel has no compact rows", () => {
  const render = createApplyResultRenderer(() => new Text("", 0, 0));
  const context = { state: {}, isError: false } as Parameters<typeof render>[3];
  const rows = render(
    {
      content: [],
      details: {
        display: {
          blocks: [],
          mutations: { results: [{ path: "large.test.ts" }] },
        },
      },
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ).render(80);
  expect(rows.join("\n")).toContain("large.test.ts");
  expect(rows.join("\n")).not.toContain("No output");
});

test("Apply keeps transaction receipts agent-only", () => {
  const results = new ApplyResults();
  results.addValue({ verified: true, transaction: "APPLY#123456789ABC" });
  const display = createApplyDisplay(results, {
    content: [
      { type: "text", text: '{"verified":true,"transaction":"APPLY#123456789ABC"}' },
      { type: "text", text: "Undo transaction: APPLY#123456789ABC" },
    ],
    level: "full",
  });
  const visible = display.blocks.map(({ text }) => text).join("\n");
  expect(visible).toContain("verified");
  expect(visible).not.toContain("APPLY#");
  expect(visible).not.toContain("transaction");
  expect(visible).not.toContain("Undo");
});

test("mixed preview stays short while a large argument streams and expansion keeps source", () => {
  const renderCall = createApplyCallRenderer((call) => `write ${call.path?.text ?? "…"}`);
  const context = { state: {}, expanded: false } as Parameters<typeof renderCall>[2];
  const prefix = 'createFile("a.txt", "';
  const source = prefix + "z".repeat(4000) + 'SENTINEL");';
  const first = renderCall({ source: prefix }, theme, context).render(60);
  const pending = renderCall({ source: source.slice(0, -4) }, theme, context).render(60);
  expect(pending).toEqual(first);
  expect(renderCall({ source }, theme, context).render(60).length).toBeLessThan(8);
  const expanded = renderCall({ source }, theme, { ...context, expanded: true }).render(60);
  expect(expanded.join("\n")).toContain("SENTINEL");
  expect(source.endsWith('SENTINEL");')).toBe(true);
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

test("Apply preview presentation controls collapsed source and expansion overrides it", () => {
  const source = Array.from(
    { length: 30 },
    (_, index) => `const line${index + 1} = ${index + 1};`,
  ).join("\n");
  const context = { state: {}, expanded: false } as Parameters<
    ReturnType<typeof createApplyCallRenderer>
  >[2];
  const full = createApplyCallRenderer((call) => call.name, "full");
  const disabled = createApplyCallRenderer((call) => call.name, "disabled");

  expect(full({ source }, theme, context).render(80).join("\n")).toContain("line15");
  expect(
    disabled({ source }, theme, context)
      .render(80)
      .map((line) => line.trimEnd()),
  ).toEqual(["apply"]);
  expect(
    disabled({ source }, theme, { ...context, expanded: true })
      .render(80)
      .join("\n"),
  ).toContain("line15");
});
test("compact Apply source keeps its head and tail within the read row budget", () => {
  const source = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
  const compact = compactApplyPreview(source, 12);
  const lines = compact.split("\n");

  expect(lines).toHaveLength(12);
  expect(lines.slice(0, 3)).toEqual(["line-1", "line-2", "line-3"]);
  expect(lines).toContain("… 19 lines omitted …");
  expect(lines.slice(-3)).toEqual(["line-28", "line-29", "line-30"]);
});

test("compact Apply call renders the source head, omission, and tail", () => {
  const renderCall = createApplyCallRenderer((call) => `[${call.name}]`);
  const source = Array.from({ length: 30 }, (_, index) =>
    index === 28 ? "result(summary);" : `const line${index + 1} = ${index + 1};`,
  ).join("\n");
  const context = { state: {}, expanded: false } as Parameters<typeof renderCall>[2];
  const rows = renderCall({ source }, theme, context).render(80).join("\n");

  expect(rows).toContain("line1");
  expect(rows).toContain("lines omitted");
  expect(rows).toContain("[result]");
  expect(rows).toContain("line30");
  expect(rows).not.toContain("line15");
});
