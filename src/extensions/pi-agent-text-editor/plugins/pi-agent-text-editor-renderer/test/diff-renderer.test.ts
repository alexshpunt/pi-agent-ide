import { describe, expect, test, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// The panel contract is row caching; a deterministic highlighter keeps this check independent of theme setup.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getLanguageFromPath: () => undefined,
  highlightCode: vi.fn((source: string) => source.split("\n")),
}));

import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { requiredValue } from "pi-agent-invariant";
import { createDiffModel } from "#src/diff-model.js";
import { COMPACT_BODY_ROWS, compactViewport, expandedViewport } from "#src/diff-viewport.js";
import { renderDiffPanel } from "#src/diff-renderer.js";
import { createDiffThemePalette } from "#src/diff-theme.js";
import { MutationPanel } from "#src/mutation-panel.js";
import {
  advanceTypingProjectionResources,
  projectTypingResources,
} from "#src/mutation-projection.js";
import type { TextMutationPreviewResource } from "pi-agent-text-editor/api/mutation-preview";

function changedRows(model: ReturnType<typeof createDiffModel>) {
  return model.rows.filter(({ changed }) => changed);
}

const foregrounds: Partial<Record<ThemeColor, string>> = {
  toolDiffAdded: "#b5bd68",
  toolDiffRemoved: "#cc6666",
  toolDiffContext: "#808080",
  success: "#b5bd68",
  error: "#cc6666",
  warning: "#ffff00",
};
const backgrounds: Readonly<Record<string, string>> = {
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  selectedBg: "#3a3a4a",
};

function themeAnsi(hex: string, layer: 38 | 48): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[${layer};2;${red};${green};${blue}m`;
}

const plainTheme = {
  fg: (_color: ThemeColor, text: string) => text,
  underline: (text: string) => text,
  getFgAnsi: (color: ThemeColor) => themeAnsi(foregrounds[color] ?? "#808080", 38),
  getBgAnsi: (color: string) => themeAnsi(backgrounds[color] ?? "#283228", 48),
  getColorMode: () => "truecolor" as const,
} as Theme;

describe("semantic text mutation diff", () => {
  test.each([200, 600, 1_000])(
    "TS-03 keeps append-only projection work proportional at %d rows",
    (lineCount) => {
      const generated =
        Array.from(
          { length: lineCount },
          (_, index) => `row ${String(index + 1).padStart(4, "0")} | é | 👩‍💻 | payload`,
        ).join("\n") + "\n";
      const resource: TextMutationPreviewResource = {
        path: "large.txt",
        beforeRanges: [{ from: 0, to: 0 }],
        ranges: [{ from: 0, to: generated.length }],
        beforeContent: "",
        afterContent: generated,
      };
      let visible = "";
      let current = requiredValue(projectTypingResources([resource], generated, visible)[0]);
      let fallbackCount = 0;
      let newRowCount = 0;
      const panel = new MutationPanel(plainTheme);
      const highlight = vi.mocked(highlightCode);
      highlight.mockClear();
      let previousRows = new Set(current.model?.rows ?? []);

      for (let index = 1; index <= lineCount; index++) {
        const nextVisible = generated.split("\n").slice(0, index).join("\n") + "\n";
        const advanced = advanceTypingProjectionResources(
          [resource],
          generated,
          [current],
          visible,
          nextVisible,
        );
        if (advanced === undefined) {
          fallbackCount++;
        }
        current = requiredValue(
          (advanced ?? projectTypingResources([resource], generated, nextVisible))[0],
        );
        const rows = current.model?.rows ?? [];
        newRowCount += rows.filter((row) => !previousRows.has(row)).length;
        previousRows = new Set(rows);
        panel.setPreviewResources([current]);
        visible = nextVisible;
      }

      const highlightedByRow = new Map<string, number>();
      for (const [text] of highlight.mock.calls) {
        for (const row of text.split("\n")) {
          if (row.startsWith("row ")) {
            highlightedByRow.set(row, (highlightedByRow.get(row) ?? 0) + 1);
          }
        }
      }
      const highlightedRowCount = [...highlightedByRow.values()].reduce(
        (total, count) => total + count,
        0,
      );
      expect(fallbackCount).toBe(0);
      expect(newRowCount).toBeLessThanOrEqual(2 * lineCount + 2);
      expect(highlightedRowCount).toBeLessThanOrEqual(2 * lineCount + 2);
      for (const row of generated.split("\n").filter(Boolean)) {
        expect(highlightedByRow.get(row)).toBe(1);
      }
    },
  );

  test("keeps completed rows visible while only the active tail changes", () => {
    const before = ["const first = oldFirst();", "const second = oldSecond();"].join("\n");
    const generated = [
      "const first = newFirst();",
      "const second = newSecond();",
      "const third = createThird();",
    ].join("\n");
    const resource: TextMutationPreviewResource = {
      path: "streaming.ts",
      beforeRanges: [{ from: 0, to: before.length }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: before,
      afterContent: generated,
    };
    const panel = new MutationPanel(plainTheme);
    panel.setHeader("replace streaming.ts · selected range");
    panel.setPreviewResources([
      requiredValue(
        projectTypingResources(
          [resource],
          generated,
          "const first = newFirst();\nconst second = new",
        )[0],
      ),
    ]);
    const firstFrame = panel.render(100).map(stripTerminalSequences);

    panel.setPreviewResources([
      requiredValue(projectTypingResources([resource], generated, generated)[0]),
    ]);
    const rendered = panel.render(100).map(stripTerminalSequences);

    expect(firstFrame[0]).toBe("replace streaming.ts · selected range");
    expect(rendered[0]).toBe(firstFrame[0]);
    expect(rendered[1]).toBe(firstFrame[1]);
    expect(firstFrame.join("\n")).toContain("const first = newFirst();");
    expect(rendered.join("\n")).toContain("const first = newFirst();");
    expect(rendered.join("\n")).toContain("const second = newSecond();");
    expect(rendered.join("\n")).toContain("const third = createThird();");
    expect(rendered.find((line) => line.includes("const first = newFirst();"))).toBe(
      firstFrame.find((line) => line.includes("const first = newFirst();")),
    );
    expect(firstFrame.at(-1)).toContain("+0 ~2 -0");
    expect(rendered.at(-1)).toContain("+1 ~2 -0");
  });

  test("keeps completed rows byte-stable when the active diff finishes", () => {
    const generated = ["first complete line", "second complete line", "active line"].join("\n");
    const resource: TextMutationPreviewResource = {
      path: "stable-finish.txt",
      beforeRanges: [{ from: 0, to: 0 }],
      ranges: [{ from: 0, to: generated.length }],
      beforeContent: "",
      afterContent: generated,
    };
    const panel = new MutationPanel(plainTheme);
    panel.setHeader("write stable-finish.txt");
    panel.setPreviewResources([
      requiredValue(projectTypingResources([resource], generated, generated)[0]),
    ]);
    const active = panel.render(100);

    panel.setResultResources([resource]);
    const completed = panel.render(100);
    const row = (frame: readonly string[], text: string) =>
      frame.find((line) => stripTerminalSequences(line).includes(text));

    expect(row(completed, "first complete line")).toBe(row(active, "first complete line"));
    expect(row(completed, "second complete line")).toBe(row(active, "second complete line"));
  });

  test("keeps final semantic counts in the panel tail", () => {
    const panel = new MutationPanel(plainTheme);
    panel.setHeader("replace service.ts · selected range");
    panel.setResultResources([
      {
        path: "service.ts",
        beforeRanges: [],
        ranges: [],
        beforeContent: "const current = load();\nconst legacy = loadLegacy();",
        afterContent: "const current = loadCurrent();\nconst trace = startTrace();",
      },
    ]);

    const rendered = panel.render(100).map(stripTerminalSequences);

    expect(rendered[0]).toBe("replace service.ts · selected range");
    expect(rendered.at(-1)).toContain("+1 ~1 -1");
    expect(rendered[0]).not.toMatch(/[+]\d+ ~\d+ -\d+/u);
  });

  test("keeps multi-resource results ordered with one aggregate count tail", () => {
    const panel = new MutationPanel(plainTheme);
    panel.setHeader("move source.ts · selected range -> target.ts · selected range");
    panel.setResourceLabelsVisible(true);
    panel.setResultResources([
      {
        path: "source.ts",
        beforeRanges: [],
        ranges: [],
        beforeContent: "keep();\nmove();\n",
        afterContent: "keep();\n",
      },
      {
        path: "target.ts",
        beforeRanges: [],
        ranges: [],
        beforeContent: "start();\n",
        afterContent: "start();\nmove();\n",
      },
    ]);

    const rendered = panel.render(100).map(stripTerminalSequences);
    const output = rendered.join("\n");

    expect(output.indexOf("source.ts")).toBeLessThan(output.indexOf("target.ts"));
    expect(output).toContain("move();");
    expect(rendered.at(-1)).toContain("+1 ~0 -1");
    expect(output.match(/\+1 ~0 -1/gu)).toHaveLength(1);
  });

  test("renders a replacement once as the final modified line", () => {
    const before = [
      'import { defineConfig } from "service";',
      "",
      "export const config = defineConfig({",
      "    timeout: 1_000,",
      "    retries: 2,",
      "});",
      "",
      "bootstrap(config);",
    ].join("\n");
    const after = before.replace("timeout: 1_000", "timeout: 5_000");
    const model = createDiffModel(before, after);

    expect(changedRows(model)).toEqual([
      expect.objectContaining({
        kind: "modified",
        text: "    timeout: 5_000,",
        beforeLine: 4,
        afterLine: 4,
        addedRanges: [{ from: 13, to: 18 }],
      }),
    ]);
    expect(model.rows.map(({ text }) => text)).not.toContain("    timeout: 1_000,");
    expect(
      model.rows.filter(({ kind }) => kind === "context").map(({ afterLine }) => afterLine),
    ).toEqual([2, 3, 5, 6]);
    expect(model).toMatchObject({ added: 0, modified: 1, removed: 0 });
  });

  test("ignores edge whitespace while keeping internal spacing semantic", () => {
    const before = "function run() {\n  execute();  \n}";
    const after = "function run() {\n    execute();\n}";
    const whitespaceOnly = createDiffModel(before, after);
    const fullWhitespace = createDiffModel(before, after, [], { project: false });

    expect(whitespaceOnly).toMatchObject({ rows: [], added: 0, modified: 0, removed: 0 });
    expect(fullWhitespace.rows.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "context", text: "function run() {" },
      { kind: "context", text: "    execute();" },
      { kind: "context", text: "}" },
    ]);

    const panel = new MutationPanel(plainTheme);
    panel.setHeader("replace config.ts");
    panel.setResultResources([
      {
        path: "config.ts",
        beforeRanges: [],
        ranges: [],
        beforeContent: before,
        afterContent: after,
      },
    ]);
    expect(panel.render(80)).toEqual(["replace config.ts"]);

    const internalSpacing = createDiffModel("const value=1;", "const value = 1;");
    expect(internalSpacing).toMatchObject({ added: 0, modified: 1, removed: 0 });

    const blankLineInsertion = createDiffModel("first\nsecond", "first\n   \nsecond");
    expect(blankLineInsertion).toMatchObject({ added: 1, modified: 0, removed: 0 });

    const finalNewlineRemoval = createDiffModel("value\n", "value");
    expect(finalNewlineRemoval).toMatchObject({ added: 0, modified: 1, removed: 0 });

    const mixed = createDiffModel("  const value = 1;  ", "    const value = 2;");
    expect(changedRows(mixed)).toEqual([
      expect.objectContaining({
        kind: "modified",
        text: "    const value = 2;",
        addedRanges: [{ from: 18, to: 19 }],
      }),
    ]);
  });

  test("keeps the tool background under a long mutation header", () => {
    const panel = new MutationPanel(plainTheme);
    panel.setBackground("toolPendingBg");
    panel.setHeader(
      "\u001B[1minsert\u001B[22m \u001B[4mtests/integration/agent/src/extensions/pi-agent-ide/" +
        "plugins/pi-agent-ide-changes/last-transaction/undo-last-transaction.integration.test.ts\u001B[24m" +
        ":216#233E +1 ~0 -0",
    );

    const [header] = panel.render(80);

    expect(header).toContain("insert");
    expect(visibleWidth(header ?? "")).toBe(80);
    expect(header).toContain(
      `${plainTheme.getBgAnsi("toolPendingBg")}...\u001B[0m${plainTheme.getBgAnsi("toolPendingBg")}`,
    );
  });

  test("restores a semantic diff-row background after nested resets", () => {
    const model = createDiffModel("old", "new");
    const row = requiredValue(model.rows.find(({ kind }) => kind === "modified"));
    const palette = createDiffThemePalette(plainTheme, false);
    const rendered = renderDiffPanel(
      {
        path: "value.ts",
        model,
        highlightedRows: new Map([[row, "ne\u001B[0mw"]]),
      },
      40,
      plainTheme,
      true,
      false,
    ).join("\n");

    expect(rendered).toContain(`ne\u001B[0m${palette.modified.emphasisBackground}`);
  });

  test("wraps long changed and removed rows with aligned continuation gutters", () => {
    const before = [
      `const message = "${"alpha beta ".repeat(14)}before";`,
      `const removed = "${"x".repeat(120)}";`,
    ].join("\n");
    const after = [`const message = "${"alpha beta ".repeat(14)}omega";`].join("\n");
    const model = createDiffModel(before, after);
    const rendered = renderDiffPanel(
      {
        path: "message.ts",
        model,
        highlightedRows: new Map(model.rows.map((row) => [row, row.text])),
      },
      36,
      plainTheme,
      true,
      false,
    );
    const plain = rendered.map(stripTerminalSequences);
    const body = plain.slice(1, -1);
    const firstSegments = body.filter((line) => /^│\s+\d+\s[+~-] /u.test(line));

    expect(body.length).toBeGreaterThan(4);
    expect(body.every((line) => visibleWidth(line) === 36)).toBe(true);
    expect(firstSegments).toEqual([
      expect.stringMatching(/^│\s+1 ~ /u),
      expect.stringMatching(/^│\s+2 - /u),
    ]);
    expect(body.filter((line) => /^│\s+\d+\s[+~-] /u.test(line))).toHaveLength(2);
    expect(plain.join("\n")).toContain("alpha");
    expect(plain.join("\n")).toContain("omega");
    expect(plain.join("\n")).toContain("xxx");
  });

  test("highlights only the new fragment with a stronger theme-derived background", () => {
    const before = "export const timeout = 1_000;";
    const after = "export const timeout = 5_000;";
    const model = createDiffModel(before, after);
    const palette = createDiffThemePalette(plainTheme, false);
    const rendered = renderDiffPanel(
      {
        path: "config.ts",
        model,
        highlightedRows: new Map(model.rows.map((row) => [row, after])),
      },
      120,
      plainTheme,
      true,
      false,
    ).join("\n");

    expect(rendered).toContain(
      `${palette.modified.emphasisBackground}5_000${palette.modified.background}`,
    );
    expect(rendered).not.toContain("\u001B[1;4m");
    expect(rendered).not.toContain("1_000");
  });

  test("aligns similar lines in a mixed hunk and leaves unmatched lines as additions or deletions", () => {
    const before = [
      "export function createService(id: string) {",
      "    const owner = resolveOwner(id);",
      "    const cacheKey = `${id}:v1`;",
      '    logger.debug("building", id);',
      "    const legacyMode = true;",
      "    return new Service(owner, cacheKey);",
      "}",
    ].join("\n");
    const after = [
      "export function createService(id: string) {",
      "    const owner = resolveOwner(id);",
      "    const cacheKey = `${id}:v2`;",
      '    logger.info("building service", id);',
      '    const trace = telemetry.startSpan("service.create");',
      "    return new Service(owner, cacheKey);",
      "}",
    ].join("\n");
    const model = createDiffModel(before, after);

    expect(changedRows(model).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "modified", text: "    const cacheKey = `${id}:v2`;" },
      { kind: "modified", text: '    logger.info("building service", id);' },
      { kind: "removed", text: "    const legacyMode = true;" },
      { kind: "added", text: '    const trace = telemetry.startSpan("service.create");' },
    ]);
    expect(model).toMatchObject({ added: 1, modified: 2, removed: 1 });

    const deletion = createDiffModel(
      'start\nconst primary = load("primary");\nconst legacy = load("legacy");\nend',
      'start\nconst primary = load("primary-v2");\nend',
    );
    expect(changedRows(deletion).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "modified", text: 'const primary = load("primary-v2");' },
      { kind: "removed", text: 'const legacy = load("legacy");' },
    ]);
    expect(deletion).toMatchObject({ added: 0, modified: 1, removed: 1 });

    const typedProperties = createDiffModel(
      "interface Options {\n    retries: number;\n    legacyMode: boolean;\n}",
      "interface Options {\n    retryLimit: number;\n    trace?: boolean;\n}",
    );
    expect(changedRows(typedProperties).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "modified", text: "    retryLimit: number;" },
      { kind: "removed", text: "    legacyMode: boolean;" },
      { kind: "added", text: "    trace?: boolean;" },
    ]);
  });

  test("uses similarity to avoid pairing an inserted line with the wrong repeated line", () => {
    const model = createDiffModel(
      [
        "export function load() {",
        '    const primary = read("primary");',
        '    const secondary = read("secondary");',
        "    return { primary, secondary };",
        "}",
      ].join("\n"),
      [
        "export function load() {",
        '    const fallback = read("fallback");',
        '    const primary = read("primary-v2");',
        '    const secondary = read("secondary");',
        "    return { primary, secondary };",
        "}",
      ].join("\n"),
    );

    expect(changedRows(model).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "added", text: '    const fallback = read("fallback");' },
      { kind: "modified", text: '    const primary = read("primary-v2");' },
    ]);
    expect(model).toMatchObject({ added: 1, modified: 1, removed: 0 });
  });

  test("keeps two context lines around distant hunks and reports the omitted gap", () => {
    const before = Array.from({ length: 30 }, (_, index) => `setting ${index + 1} = false;`).join(
      "\n",
    );
    const after = before
      .replace("setting 5 = false", "setting 5 = true")
      .replace("setting 20 = false", "setting 20 = true");
    const model = createDiffModel(before, after);

    expect(
      model.rows.map(({ kind, afterLine, omitted }) => ({ kind, afterLine, omitted })),
    ).toEqual([
      { kind: "context", afterLine: 3, omitted: undefined },
      { kind: "context", afterLine: 4, omitted: undefined },
      { kind: "modified", afterLine: 5, omitted: undefined },
      { kind: "context", afterLine: 6, omitted: undefined },
      { kind: "context", afterLine: 7, omitted: undefined },
      { kind: "omitted", afterLine: undefined, omitted: 10 },
      { kind: "context", afterLine: 18, omitted: undefined },
      { kind: "context", afterLine: 19, omitted: undefined },
      { kind: "modified", afterLine: 20, omitted: undefined },
      { kind: "context", afterLine: 21, omitted: undefined },
      { kind: "context", afterLine: 22, omitted: undefined },
    ]);
    expect(model.rows.some(({ afterLine }) => afterLine === 1 || afterLine === 30)).toBe(false);
  });

  test("merges overlapping context windows without duplicating unchanged lines", () => {
    const before = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 5", "changed 5").replace("line 9", "changed 9");
    const model = createDiffModel(before, after);

    expect(model.rows.some(({ kind }) => kind === "omitted")).toBe(false);
    expect(model.rows.filter(({ afterLine }) => afterLine === 7)).toHaveLength(1);
    expect(
      model.rows
        .map(({ afterLine }) => afterLine)
        .filter((line): line is number => line !== undefined),
    ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("does not invent a changed fragment for a deletion-only modified line", () => {
    const model = createDiffModel(
      "export const flags = { enabled: true, legacy: false };",
      "export const flags = { enabled: true };",
    );

    expect(changedRows(model)).toEqual([
      expect.objectContaining({
        kind: "modified",
        text: "export const flags = { enabled: true };",
        addedRanges: [],
      }),
    ]);
  });

  test("compact mode clips only the hunk projection while expanded mode keeps all projected hunks", () => {
    const before = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before
      .replace("line 5", "changed 5")
      .replace("line 40", "changed 40")
      .replace("line 75", "latest change");
    const latest = after.indexOf("latest change");
    const model = createDiffModel(before, after, [
      { from: latest, to: latest + "latest change".length },
    ]);
    const compact = compactViewport(model);
    const expanded = expandedViewport(model);

    expect(compact).toHaveLength(COMPACT_BODY_ROWS);
    expect(compact.some(({ row }) => row?.text === "latest change")).toBe(true);
    expect(compact[0]?.omitted).toBeGreaterThan(0);
    expect(expanded).toHaveLength(model.rows.length);
    expect(expanded.some(({ row }) => row?.afterLine === 1 || row?.afterLine === 80)).toBe(false);
  });
});
