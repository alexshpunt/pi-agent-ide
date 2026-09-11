import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createSettingsPanel } from "./settings-panel.js";

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
