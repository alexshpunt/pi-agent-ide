import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Image, visibleWidth } from "@earendil-works/pi-tui";
import { ReadResultPanel } from "#src/extensions/pi-agent-read/src/core/tools/read/read-renderer.js";
import { SearchResultPanel } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/search-renderer.js";
import { MutationPanel } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/mutation-panel.js";
import { createDiffModel } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/diff-model.js";
import { createSettingsPanel } from "#src/composite/settings-panel.js";
import { renderRunResult } from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";

/** Exercises native theme changes on an existing diff without changing saved settings. */
export default function themeChangeFixture(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "theme_palette",
    label: "System palette",
    description: "Supply terminal color reports through Pi native input handling.",
    parameters: Type.Object({ light: Type.Boolean() }),
    async execute(_id, args) {
      if (panel === undefined || activeTheme === undefined) throw new Error("Panels not shown");
      // Close any outstanding startup query, then let Pi query after the appearance notification.
      process.stdin.emit("data", "\u001b[?1;2c");
      process.stdin.emit("data", `\u001b[?997;${args.light ? 2 : 1}n`);
      // Light replies arrive after Pi's initial query wait, exercising its late-reply path.
      await delay(args.light ? 150 : 10);
      const background = args.light ? "f2f2f2" : "181818";
      const foreground = args.light ? "202020" : "eeeeee";
      const colors = [
        background,
        "cc3333",
        "339933",
        "bb9933",
        "3377bb",
        "9944bb",
        "339999",
        foreground,
        "777777",
        "ff5555",
        "55cc55",
        "dddd55",
        "5599ff",
        "cc66dd",
        "55cccc",
        "ffffff",
      ];
      const rgb = (hex: string) => `rgb:${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}`;
      for (const [index, color] of colors.entries()) {
        process.stdin.emit("data", `\u001b]4;${index};${rgb(color)}\u0007`);
      }
      process.stdin.emit("data", `\u001b]10;${rgb(foreground)}\u0007`);
      process.stdin.emit("data", `\u001b]11;${rgb(background)}\u0007`);
      process.stdin.emit("data", "\u001b[?1;2c");
      await delay(40);
      const fresh = createPanels(activeTheme);
      const matches = JSON.stringify(panel.render(40)) === JSON.stringify(fresh.render(40));
      return {
        content: [
          {
            type: "text",
            text: `system appearance=${activeTheme.appearance}; matches fresh=${String(matches)}`,
          },
        ],
        details: { matches },
      };
    },
  });
  pi.registerTool({
    name: "theme_settings",
    label: "Settings focus",
    description: "Close the IDE settings and check native keyboard focus.",
    parameters: Type.Object({ overlay: Type.Boolean() }),
    async execute(_id, args, _signal, _update, context) {
      context.ui.setEditorText("");
      let escapeTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let result: string;
      try {
        result = await context.ui.custom<string>(
          (_tui, theme, _keys, done) => {
            escapeTimer = setTimeout(() => process.stdin.emit("data", "\u001b"), 100);
            timeoutTimer = setTimeout(() => done("timeout"), 2000);
            return createSettingsPanel(
              theme,
              () => ({
                modules: [
                  {
                    id: "test",
                    label: "Theme fixture",
                    currentValue: "enabled",
                    values: ["enabled", "disabled"],
                  },
                ],
                features: [],
              }),
              () => {},
              (save) => done(save ? "saved" : "cancelled"),
            );
          },
          { overlay: args.overlay },
        );
      } finally {
        clearTimeout(escapeTimer);
        clearTimeout(timeoutTimer);
      }
      if (result !== "cancelled") throw new Error(`Settings did not handle Escape: ${result}`);
      process.stdin.emit("data", "focus restored");
      await delay(30);
      const restored = context.ui.getEditorText() === "focus restored";
      return {
        content: [
          {
            type: "text",
            text: `settings cancelled; native keyboard restored=${String(restored)}`,
          },
        ],
        details: { restored },
      };
    },
  });
  const beforeContent = "const count = 1;\n";
  const afterContent = "const count = 2;\n";
  const resource = {
    path: "theme-sample.ts",
    beforeContent,
    afterContent,
    ranges: [],
    model: createDiffModel(beforeContent, afterContent),
  };
  const createPanels = (theme: Theme): Container => {
    const container = new Container();
    container.addChild(
      new Image(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhuQAAAAASUVORK5CYII=",
        "image/png",
        { fallbackColor: (text) => theme.fg("dim", text) },
        { filename: "theme-image.png", maxWidthCells: 8, maxHeightCells: 2 },
        { widthPx: 1, heightPx: 1 },
      ),
    );
    const mutation = new MutationPanel(theme);
    mutation.setResultResources([resource]);
    container.addChild(mutation);
    const source = `long/${"nested/".repeat(8)}unicode-界.ts`;
    const content = 'const greeting = "hello 界 👋";';
    const details = {
      source,
      resolvedBy: "theme-fixture",
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      lines: [
        { lineNumber: 1, content, lineEnding: "\n" as const },
        { lineNumber: 2, content: "\u001b[31mcolored\u001b[0m", lineEnding: "" as const },
      ],
    };
    container.addChild(
      new ReadResultPanel({
        result: { content: [{ type: "text", text: content }], details },
        details,
        options: { kind: "code-view" },
        expanded: true,
        theme,
      }),
    );
    container.addChild(
      new SearchResultPanel(
        {
          query: "hello",
          matchCount: 1,
          fileCount: 1,
          complete: true,
          files: [
            {
              path: source,
              link: "file:///theme-fixture.ts",
              matchCount: 1,
              lines: [
                {
                  lineNumber: 1,
                  text: content,
                  matchCount: 1,
                  ranges: [{ from: content.indexOf("hello"), to: content.indexOf("hello") + 5 }],
                },
              ],
            },
          ],
        },
        theme,
        true,
      ),
    );
    // Terminal results are rebuilt by Pi on invalidation, rather than retaining a panel cache.
    container.addChild({
      invalidate() {},
      render: (width) =>
        renderRunResult(
          {
            status: "completed",
            shell: "Bash",
            shellFamily: "posix",
            cwd: source,
            command: "printf output",
            output: "shell Unicode 界 👋\n\u001b[31mcolored shell\u001b[0m\n",
            exitCode: 0,
          },
          "full",
          theme,
        ).render(width),
    });
    return container;
  };
  let panel: Container | undefined;
  let activeTheme: Theme | undefined;
  pi.on("session_start", async (_event, context) => {
    const external = process.env.PI_AGENT_IDE_TEST_EXTERNAL_THEME;
    if (external !== undefined) {
      // The integration runner owns this isolated agent directory.
      const themes = path.join(getAgentDir(), "themes");
      await mkdir(themes, { recursive: true });
      await copyFile(external, path.join(themes, path.basename(external)));
    }
    const result = context.ui.setTheme("dark");
    if (!result.success) throw new Error(result.error);
  });
  pi.registerTool({
    name: "theme_diff",
    label: "Theme diff",
    description: "Show a diff for theme verification.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "Diff ready" }], details: undefined };
    },
    renderResult(_result, _options, theme) {
      activeTheme = theme;
      if (panel === undefined) {
        panel = createPanels(theme);
      }
      return panel;
    },
  });
  pi.registerTool({
    name: "theme_switch",
    label: "Switch theme",
    description: "Change the native theme and check the existing diff.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, args, _signal, _update, context) {
      if (panel === undefined || activeTheme === undefined) throw new Error("Diff not shown");
      const result = context.ui.setTheme(args.name);
      if (!result.success) throw new Error(result.error);
      panel.invalidate();
      const fresh = createPanels(activeTheme);
      const existing = panel;
      const matches = [40, 80].every((width) => {
        const rows = existing.render(width);
        return (
          rows.every((row) => visibleWidth(row) <= width) &&
          JSON.stringify(rows) === JSON.stringify(fresh.render(width))
        );
      });
      return {
        content: [
          { type: "text", text: `${args.name}: existing diff matches fresh=${String(matches)}` },
        ],
        details: { matches },
      };
    },
  });
}
