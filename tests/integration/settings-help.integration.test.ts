import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.each(["dark", "light"])(
  "help is transient and scrollable with modules disabled in %s",
  async (theme) => {
    await withTempWorkspace(async (cwd) => {
      const settings = JSON.stringify({
        disabled: BUILTIN_EXTENSIONS.map((item) => item.id),
        preferences: { "ui.codemode": "full" },
      });
      const config = path.join(cwd, ".pi/pi-agent-ide/extensions.json");
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, settings);
      const probe = path.join(cwd, "probe.json");
      const run = await new PiIntegrationTest({
        testName: `settings-help-${theme}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        tuiSize: { cols: 60, rows: 24 },
        extensions: [path.resolve("tests/integration/fixtures/settings-help-probe.ts")],
        tools: [],
        environment: {
          IDE_SETTINGS_HELP_SOURCE: path.resolve(
            process.env.IDE_SETTINGS_HELP_SOURCE ?? "src/pi-agent-ide.ts",
          ),
          IDE_SETTINGS_HELP_PROBE: probe,
          IDE_SETTINGS_HELP_THEME: theme,
        },
        conversation: [assistantMessage([text("Ready")])],
      }).run("/agent-ide-help");
      const result = JSON.parse(await readFile(probe, "utf8")) as {
        registered: boolean;
        frames: string[][];
        timedOut: boolean;
        unchanged: boolean;
        focused: boolean;
        requests: number;
      };
      expect(result.registered).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.unchanged).toBe(true);
      expect(result.focused).toBe(true);
      expect(result.requests).toBe(0);
      expect(result.frames.length).toBeGreaterThanOrEqual(3);
      expect(new Set(result.frames.map((frame) => JSON.stringify(frame))).size).toBeGreaterThan(1);
      expect(result.frames.flat().every((row) => visibleWidth(row) <= 58)).toBe(true);
      expect(result.frames.at(-1)).toEqual(result.frames[0]);
      expect(run.providerRequests).toHaveLength(1);
      expect(JSON.stringify(run.providerRequests)).not.toContain("Agent IDE settings help");
      expect(JSON.stringify(run.messages)).not.toContain("/agent-ide-help");
      expect(await readFile(config, "utf8")).toBe(settings);
      expect(run.tuiRenderedOutput).toContain("Ready");
    });
  },
);
