import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MutationPanel } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/mutation-panel.js";
import { createDiffModel } from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/src/diff-model.js";

/** Exercises native theme changes on an existing diff without changing saved settings. */
export default function themeChangeFixture(pi: ExtensionAPI): void {
  const beforeContent = "const count = 1;\n";
  const afterContent = "const count = 2;\n";
  const resource = {
    path: "theme-sample.ts",
    beforeContent,
    afterContent,
    ranges: [],
    model: createDiffModel(beforeContent, afterContent),
  };
  let panel: MutationPanel | undefined;
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
        panel = new MutationPanel(theme);
        panel.setResultResources([resource]);
      }
      panel.setTheme(theme);
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
      const fresh = new MutationPanel(activeTheme);
      fresh.setResultResources([resource]);
      const matches = [40, 80].every((width) =>
        JSON.stringify(panel?.render(width)) === JSON.stringify(fresh.render(width)),
      );
      return {
        content: [{ type: "text", text: `${args.name}: existing diff matches fresh=${String(matches)}` }],
        details: { matches },
      };
    },
  });
}
