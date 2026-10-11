import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { registerSettingsHelp, SettingsHelpPanel } from "./settings-help.js";

initTheme("dark", false);
const theme = { fg: (_color: string, value: string) => value } as Theme;

test.each(["rpc", "json", "print"] as const)(
  "help does not open a terminal reader in %s",
  async (mode) => {
    let handler: RegisteredCommand["handler"] | undefined;
    registerSettingsHelp({
      registerCommand: (_name, command) => {
        handler = command.handler;
      },
    });
    if (handler === undefined) throw new Error("Help command was not registered");
    const custom = vi.fn();
    const notify = vi.fn();
    const ui: Partial<ExtensionCommandContext["ui"]> = { custom, notify };
    const context: Partial<ExtensionCommandContext> = {
      mode,
      hasUI: true,
      ui: ui as ExtensionCommandContext["ui"],
    };
    await handler("", context as ExtensionCommandContext);
    expect(custom).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  },
);

const markdown = Array.from(
  { length: 80 },
  (_, index) => `Paragraph ${index} with wide text 界.`,
).join("\n\n");

test("help scrolls to both ends, pages and closes without changing its content", () => {
  const done = vi.fn();
  const render = vi.fn();
  const panel = new SettingsHelpPanel(markdown, theme, () => 16, render, done);
  const first = panel.render(50).join("\n");
  expect(first).toContain("Paragraph 0");
  expect(first).not.toContain("Paragraph 79");
  panel.handleInput("\x1b[6~");
  expect(panel.render(50).join("\n")).not.toBe(first);
  panel.handleInput("\x1b[F");
  expect(panel.render(50).join("\n")).toContain("Paragraph 79");
  panel.handleInput("\x1b[H");
  expect(panel.render(50).join("\n")).toBe(first);
  panel.handleInput("\x1b");
  expect(done).toHaveBeenCalledExactlyOnceWith();
  expect(render).toHaveBeenCalled();
});

test("help keeps every row within the resized viewport and invalidates theme layout", () => {
  let height = 16;
  const panel = new SettingsHelpPanel(markdown, theme, () => height, vi.fn(), vi.fn());
  panel.render(60);
  panel.handleInput("\x1b[F");
  height = 10;
  panel.invalidate();
  for (const width of [24, 40, 60]) {
    const rows = panel.render(width);
    expect(rows).toHaveLength(height);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  }
  // Resize is rendered before the next key is delivered.
  panel.render(24);
  panel.handleInput("\x1b[F");
  expect(panel.render(24).join("\n")).toContain("Paragraph 79");
});
