import { expect, test } from "vitest";
import { ResultPanel } from "pi-agent-tool-ui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { selectPresentation } from "./select-presentation.js";
import type { SelectedRegion } from "./ast/selection.js";

const theme = Object.assign(Object.create(null) as Theme, {
  fg: (_color: string, s: string) => s,
  bg: (_color: string, s: string) => `\u001B[48;5;25m${s}\u001B[49m`,
  bold: (s: string) => s,
  underline: (s: string) => s,
});

test("groups selections by file, highlights only exact boundaries and expands origins", () => {
  const content = '"😀"; function a() {\r\n  probe();\r\n} function b() {}';
  const range = { start: { lineNumber: 1, column: 6 }, end: { lineNumber: 3, column: 1 } };
  const region: SelectedRegion = {
    target: { source: "/work/a.ts", expectedContent: content, ranges: [range] },
    range,
    text: content.slice(6, content.indexOf(" function b")),
    origins: [
      {
        source: "/work/a.ts",
        range: { startLine: 2, startColumn: 2, endLine: 2, endColumn: 9 },
        expanded: true,
      },
      {
        source: "/work/a.ts",
        range: { startLine: 2, startColumn: 2, endLine: 2, endColumn: 9 },
        expanded: true,
      },
    ],
  };
  const model = selectPresentation([region], true, 0, "/work");
  const compact = new ResultPanel(model, theme, false).render(100).join("\n");
  const expanded = new ResultPanel(model, theme, true).render(100).join("\n");
  expect(stripTerminalSequences(compact)).toContain("╭─ 1 selection in 1 file");
  expect(stripTerminalSequences(compact).match(/a\.ts/gu)).toHaveLength(1);
  expect(compact).toContain("\u001B[48;5;25mfunction a()");
  expect(compact).not.toContain('25m"😀"');
  expect(compact).not.toContain("25m function b");
  expect(compact).not.toContain("origin(s)");
  expect(expanded).toContain("1:6–3:1 · 2 origin(s) · expanded");
  expect(expanded).toContain("from 2:2–2:9");
  expect(region.target.expectedContent).toBe(content);
});

test("retains full counts while bounding large selection previews", () => {
  const content = "function large() {\n" + "  probe();\n".repeat(100) + "}";
  const range = { start: { lineNumber: 1, column: 0 }, end: { lineNumber: 102, column: 1 } };
  const region: SelectedRegion = {
    target: { source: "/work/a.ts", expectedContent: content, ranges: [range] },
    range,
    text: content,
    origins: [],
  };
  const model = selectPresentation(
    Array.from({ length: 105 }, () => region),
    false,
    3,
    "/work",
  );
  expect(model.summary).toBe("105 selections in 1 file · incomplete");
  const output = new ResultPanel(model, theme, true)
    .render(100)
    .map(stripTerminalSequences)
    .join("\n");
  expect(output).toContain("preview shortened");
  expect(output).toContain("more selections");
  expect(output).toContain("3 input(s) without a selection");
  expect(model.rows.filter((row) => row.kind === "line")).toHaveLength(20);
});
