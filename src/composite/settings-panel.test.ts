import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
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
