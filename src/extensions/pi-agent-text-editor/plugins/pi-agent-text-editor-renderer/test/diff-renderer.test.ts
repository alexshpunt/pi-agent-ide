import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { createDiffModel } from "#src/diff-model.js";
import { COMPACT_BODY_ROWS, compactViewport, expandedViewport } from "#src/diff-viewport.js";
import { renderDiffPanel } from "#src/diff-renderer.js";
import { createDiffThemePalette } from "#src/diff-theme.js";
import { MutationPanel } from "#src/mutation-panel.js";

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
  getFgAnsi: (color: ThemeColor) => themeAnsi(foregrounds[color] ?? "#808080", 38),
  getBgAnsi: (color: string) => themeAnsi(backgrounds[color] ?? "#283228", 48),
  getColorMode: () => "truecolor" as const,
} as Theme;

describe("semantic text mutation diff", () => {
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
    panel.setBackground("toolSuccessBg");
    panel.setHeader(
      "\u001B[1minsert\u001B[22m \u001B[4mtests/integration/agent/src/extensions/pi-agent-ide/" +
        "plugins/pi-agent-ide-changes/last-transaction/undo-last-transaction.integration.test.ts\u001B[24m" +
        ":216#233E +1 ~0 -0",
    );

    const [header] = panel.render(80);

    expect(header).toContain("insert");
    expect(visibleWidth(header ?? "")).toBe(80);
    expect(header).toContain(`${plainTheme.getBgAnsi("toolSuccessBg")}...\u001B[0m`);
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
