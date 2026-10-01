import { afterEach, expect, test } from "vitest";
import { requiredValue } from "pi-agent-invariant";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { MutationPanel } from "#src/mutation-panel.js";
import { createDiffModel } from "#src/diff-model.js";

// Pi keeps one proxy while replacing the theme behind it.
const theme = new Proxy({} as Theme, {
  get: (_target, key) => {
    const host = globalThis as typeof globalThis & { [key: symbol]: Theme };
    return requiredValue(host[Symbol.for("@earendil-works/pi-coding-agent:theme")])[
      key as keyof Theme
    ];
  },
});
const beforeContent = "const count = 1;\n";
const afterContent = "const count = 2;\n";
const resource = {
  path: "sample.ts",
  beforeContent,
  afterContent,
  ranges: [],
  model: createDiffModel(beforeContent, afterContent),
};

afterEach(() => initTheme("dark"));

test.each([40, 80])("old diff uses the new theme at %i columns", (width) => {
  initTheme("dark");
  const panel = new MutationPanel(theme);
  panel.setResultResources([resource]);
  const before = panel.render(width);
  initTheme("light");
  panel.setTheme(theme);
  panel.invalidate();
  const fresh = new MutationPanel(theme);
  fresh.setResultResources([resource]);
  const actual = panel.render(width);
  expect(actual.map(stripTerminalSequences)).toEqual(before.map(stripTerminalSequences));
  expect(actual.every((line) => visibleWidth(line) <= width)).toBe(true);
  expect(actual).toEqual(fresh.render(width));
  panel.setResultResources([resource]);
  expect(panel.render(width)).toEqual(fresh.render(width));
});
