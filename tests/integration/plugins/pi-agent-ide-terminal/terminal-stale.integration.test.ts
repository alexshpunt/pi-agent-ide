import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { PiRun } from "pi-coding-agent-test/base";

const root = path.resolve();

test.runIf(process.platform !== "win32")(
  "delivers one stale reminder then completion for a quiet process",
  async () => {
    const workspace = path.join(root, ".tmp/terminal-stale/workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const result = await new PiIntegrationTest({
        testName: "terminal-one-stale-reminder",
        artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".tmp/test-runs")),
        cwd: workspace,
        extensions: [path.join(root, "tests/integration/fixtures/terminal-stale.ts")],
        tools: ["bash"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "quiet-process",
                name: "bash",
                arguments: {
                  command: "sleep 7; printf 'quiet-process-completed'",
                  background: true,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("I will wait for the quiet process.")]),
          assistantMessage([text("The process is healthy; keep waiting.")]),
          assistantMessage([text("The process completed.")]),
        ],
      }).run("Run a quiet background process and handle its notices");

      expect(getToolResultText(result, "quiet-process")).toContain("status: running");
      const notices = result.traceEvents.filter((event) => event.type === "message_end");
      for (const type of ["terminal-stale", "terminal-completion"]) {
        expect(
          notices.filter((event) => JSON.stringify(event).includes(`"customType":"${type}"`)),
        ).toHaveLength(1);
      }
      expect(result.tuiRenderedOutput).toContain("stale · inspect session");
      expect(result.tuiRenderedOutput).toContain("quiet-process-completed");
      const saved = await PiRun.open(result.artifacts.run);
      const entries = (saved.session ?? "")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              customType?: string;
              data?: { parentToolCallId?: string };
              display?: boolean;
            },
        );
      for (const type of ["terminal-stale-display", "terminal-completion-display"]) {
        const cards = entries.filter(
          (entry) => entry.type === "custom" && entry.customType === type,
        );
        expect(cards).toHaveLength(1);
        expect(cards[0]?.data?.parentToolCallId).toBe("quiet-process");
      }
      expect(
        entries
          .filter((entry) => entry.type === "custom_message")
          .every((entry) => entry.display === false),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
