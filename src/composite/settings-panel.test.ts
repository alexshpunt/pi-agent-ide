import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createSettingsPanel } from "./settings-panel.ts";

initTheme("dark", false);

test("tabs route changes to their own registry and save without canceling", () => {
  const change = vi.fn();
  const done = vi.fn();
  const panel = createSettingsPanel(
    {} as Theme,
    () => ({
      modules: [
        { id: "core", label: "Core", currentValue: "default", values: ["default", "enabled"] },
      ],
      features: [
        { id: "future", label: "Future", currentValue: "default", values: ["default", "enabled"] },
      ],
    }),
    change,
    done,
  );
  panel.handleInput("\r");
  panel.handleInput("\t");
  panel.handleInput("\r");
  expect(change.mock.calls).toEqual([
    ["modules", "core", "enabled"],
    ["features", "future", "enabled"],
  ]);
  panel.handleInput("\x13");
  expect(done.mock.calls).toEqual([[true]]);
});

test("renders a bordered settings panel with feature-first tabs", () => {
  const style = ((...args: string[]) => args.at(-1) ?? "") as Theme["fg"];
  const theme = { fg: style, bold: (value: string) => value } as Theme;
  const panel = createSettingsPanel(
    theme,
    () => ({
      modules: [
        { id: "terminal", label: "Terminal", currentValue: "default", values: ["default"] },
      ],
      features: [],
    }),
    vi.fn(),
    vi.fn(),
    "Project",
  );

  const rendered = panel.render(64);
  expect(rendered[0]).toContain("Agent IDE settings · Project");
  expect(rendered[1]).toContain("[ Features ]");
  expect(rendered[1]).toContain("Behavior");
  expect(
    rendered.every(
      (line) =>
        line.startsWith("│") ||
        line.startsWith("╭") ||
        line.startsWith("├") ||
        line.startsWith("╰"),
    ),
  ).toBe(true);
  expect(rendered.every((line) => visibleWidth(line) === 64)).toBe(true);
});

function longPanel(rows?: number) {
  const style = ((...args: string[]) => args.at(-1) ?? "") as Theme["fg"];
  const theme = { fg: style, bold: (value: string) => value } as Theme;
  return createSettingsPanel(
    theme,
    () => ({
      modules: Array.from({ length: 35 }, (_, index) => ({
        id: `module-${index}`,
        label: `Module ${index}`,
        description: "A long description that wraps onto several lines in a narrow panel.",
        currentValue: "default",
        values: ["default", "enabled"],
      })),
      features: [],
    }),
    vi.fn(),
    vi.fn(),
    "Project",
    rows === undefined ? undefined : () => rows,
  );
}

test.each([120, 80, 60, 40])("keeps the Ctrl+S hint in the footer at width %i", (width) => {
  const rendered = longPanel().render(width);
  expect(rendered.at(-2)).toContain("Ctrl+S save");
  expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
});

test.each([40, 30, 22])("fits the whole panel above Pi's footer in %i rows", (rows) => {
  const rendered = longPanel(rows).render(80);
  expect(rendered.length).toBeLessThanOrEqual(rows - 3);
  expect(rendered.at(-2)).toContain("Ctrl+S save");
});
