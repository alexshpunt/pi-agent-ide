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
test.each([40, 80])("old diff follows native theme changes at %i columns", async (cols) => {
  await withTempWorkspace(async (cwd) => {
    const result = await new PiIntegrationTest({
      testName: `native-diff-theme-change-${cols}`,
      tuiSize: { cols, rows: 80 },
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      cwd,
      rawMode: false,
      extensions: [path.resolve("tests/integration/fixtures/theme-change.ts")],
      tools: ["theme_diff", "theme_switch"],
      conversation: [
        assistantMessage([toolCall({ id: "diff", name: "theme_diff", arguments: {} })], {
          stopReason: "toolUse",
        }),
        ...themes.map((name) =>
          assistantMessage([toolCall({ id: name, name: "theme_switch", arguments: { name } })], {
            stopReason: "toolUse",
          }),
        ),
        assistantMessage([text("Theme verification complete.")]),
      ],
    }).run("Show a diff, then change themes.");
    for (const name of themes) {
      expect(getToolExecution(result, name).isError).toBe(false);
      expect(getToolResultText(result, name)).toContain("matches fresh=true");
    }
    expect(result.tuiRenderedOutput).toContain("const count = 2;");
  });
});
