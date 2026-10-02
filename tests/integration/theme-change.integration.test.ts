import path from "node:path";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  PiIntegrationTest,
  assistantMessage,
  toolCall,
  text,
  getToolResultText,
  getToolExecution,
  testArtifactsDir,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";

// Set this to a theme JSON file to include a real external palette in the same scenario.
const externalTheme = process.env.PI_AGENT_IDE_TEST_EXTERNAL_THEME;
const themes = [
  "light",
  ...(externalTheme === undefined ? [] : [path.basename(externalTheme, ".json")]),
  "dark",
  "system",
];
test.each([
  [40, "1"],
  [80, "1"],
  [40, "0"],
  [80, "0"],
] as const)(
  "old panels follow native theme changes at %i columns; truecolor=%s",
  async (cols, trueColor) => {
    await withTempWorkspace(async (cwd) => {
      const result = await new PiIntegrationTest({
        testName: `native-diff-theme-change-${cols}-${trueColor}`,
        environment: { PI_TRUE_COLOR: trueColor, PI_IMAGE_PROTOCOL: "none" },
        tuiSize: { cols, rows: 80 },
        artifactsDir: testArtifactsDir(import.meta.filename),
        isolateUserResources: true,
        cwd,
        rawMode: false,
        extensions: [path.resolve("tests/integration/fixtures/theme-change.ts")],
        tools: ["theme_diff", "theme_switch", "theme_palette", "theme_settings"],
        conversation: [
          assistantMessage([toolCall({ id: "diff", name: "theme_diff", arguments: {} })], {
            stopReason: "toolUse",
          }),
          ...themes.map((name) =>
            assistantMessage([toolCall({ id: name, name: "theme_switch", arguments: { name } })], {
              stopReason: "toolUse",
            }),
          ),
          ...[true, false].map((light) =>
            assistantMessage(
              [
                toolCall({
                  id: light ? "system-light" : "system-dark",
                  name: "theme_palette",
                  arguments: { light },
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          ...[false, true].map((overlay) =>
            assistantMessage(
              [
                toolCall({
                  id: overlay ? "overlay" : "settings",
                  name: "theme_settings",
                  arguments: { overlay },
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          assistantMessage([text("Theme verification complete.")]),
        ],
      }).run("Show a diff, then change themes.");
      for (const name of themes) {
        expect(getToolExecution(result, name).isError).toBe(false);
        expect(getToolResultText(result, name)).toContain("matches fresh=true");
      }
      for (const appearance of ["light", "dark"]) {
        expect(getToolExecution(result, `system-${appearance}`).isError).toBe(false);
        expect(getToolResultText(result, `system-${appearance}`)).toContain(
          `system appearance=${appearance}; matches fresh=true`,
        );
      }
      for (const id of ["settings", "overlay"]) {
        expect(getToolExecution(result, id).isError).toBe(false);
        expect(getToolResultText(result, id)).toContain("native keyboard restored=true");
      }
      expect(result.terminalOutput.match(/\u001b\[\?25[hl]/g)?.at(-1)).toBe("\u001b[?25h");
      expect(result.terminalOutput).toContain("\u001b[<u");
      expect(result.tuiRenderedOutput).toContain("focus restored");
      expect(result.tuiRenderedOutput).toContain("const count = 2;");
      expect(result.tuiRenderedOutput).toContain("hello 界 👋");
      expect(result.tuiRenderedOutput).toContain("colored");
      expect(result.tuiRenderedOutput).toContain("theme-image.png");
      expect(result.tuiRenderedOutput).toContain("shell Unicode 界 👋");
    });
  },
);
