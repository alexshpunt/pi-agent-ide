import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.runIf(process.platform !== "win32")(
  "keeps Pi usable after shell search at 40 columns",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const run = await new PiIntegrationTest({
        testName: "terminal-search-width-40",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        tuiSize: { cols: 40, rows: 50 },
        rawMode: false,
        isolateUserResources: true,
        extensions: [
          path.resolve("src/extensions/pi-agent-search/index.ts"),
          path.resolve("tests/integration/fixtures/terminal-search-deterministic.ts"),
        ],
        tools: ["bash", "search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "fixture",
                name: "bash",
                arguments: {
                  command:
                    "for i in 1 2 3 4 5 6; do printf 'Official run: https://github.com/alexshpunt/explicit-edit-benchmark-run/actions/runs/36568016139\\n'; done",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "search-shell",
                name: "search",
                arguments: {
                  path: "shell:abcdef123456",
                  query: "Official run:",
                  limit: 30,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Session still usable.")]),
        ],
      }).run("Search the safe shell fixture and continue after the narrow result");

      expect(run.tuiSize).toEqual({ cols: 40, rows: 50 });
      expect(getToolExecution(run, "search-shell").isError).toBe(false);
      const result = getToolResultText(run, "search-shell");
      expect(result).toContain("6 matches in shell:abcdef123456");
      expect(result).toContain(
        "https://github.com/alexshpunt/explicit-edit-benchmark-run/actions/runs/36568016139",
      );
      expect(run.tuiRenderedOutput).toContain("visual rows omitted · ctrl+o");
      expect(run.tuiRenderedOutput).toContain("Session still usable.");
      expect(run.state?.isIdle).toBe(true);
    });
  },
);
