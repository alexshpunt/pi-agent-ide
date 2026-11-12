import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

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
      expect(run.tuiRenderedOutput).toContain("output truncated");
      expect(run.tuiRenderedOutput).toContain("╭─ 6+ matches in 1 source");
      expect(run.tuiRenderedOutput).toContain("Retained terminal output");
      expect(run.tuiRenderedOutput).toContain("Session still usable.");
      expect(run.state?.isIdle).toBe(true);
    });
  },
);

test.runIf(process.platform !== "win32")(
  "searches retained terminal output with a regex query",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const search = (id: string, scope: string, query: string) =>
        assistantMessage([toolCall({ id, name: "search", arguments: { path: scope, query } })], {
          stopReason: "toolUse",
        });
      const run = await new PiIntegrationTest({
        testName: "terminal-search-regex",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        tuiSize: { cols: 80, rows: 50 },
        rawMode: false,
        isolateUserResources: true,
        extensions: [
          path.resolve("src/extensions/pi-agent-search/index.ts"),
          // The filesystem regex resolver that used to read `shell:` as a file path.
          path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts"),
          path.resolve("tests/integration/fixtures/terminal-search-deterministic.ts"),
        ],
        tools: ["bash", "search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "fixture",
                name: "bash",
                arguments: { command: "printf 'alpha 42\\nbeta\\ngamma 7\\n'" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          search("all-sessions", "shell:", "regex:\\w+ \\d+"),
          search("one-session", "shell:abcdef123456", "regex:^beta$"),
          search("no-match", "shell:", "regex:zzz+"),
          assistantMessage([text("Done.")]),
        ],
      }).run("Search retained shell output with regular expressions");

      for (const id of ["all-sessions", "one-session", "no-match"]) {
        expect(getToolExecution(run, id).isError).toBe(false);
      }
      const all = getToolResultText(run, "all-sessions");
      expect(all).toContain("alpha 42");
      expect(all).toContain("gamma 7");
      expect(getToolResultText(run, "one-session")).toContain("beta");
      expect(getToolResultText(run, "no-match")).toContain("No matches in");
    });
  },
);
