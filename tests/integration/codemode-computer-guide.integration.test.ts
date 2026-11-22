import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  computerResult,
  computerSource,
  guide,
} from "#integration/fixtures/codemode-computer-guide.ts";
import { expect, test } from "vitest";

test.each(["collapsed", "expanded"])(
  "Codemode keeps the computer guide for the agent and hides it in the %s TUI",
  async (view) => {
    await withTempWorkspace(async (cwd) => {
      const code = `const windows = await tools.read({path:${JSON.stringify(computerSource)}}); text(windows.text);`;
      const run = await new PiIntegrationTest({
        testName: `codemode-computer-guide-${view}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 100, rows: 45 },
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/fixtures/codemode-computer-guide.ts"),
          ...(view === "collapsed"
            ? [path.resolve("tests/integration/fixtures/codemode-presentation-probe.ts")]
            : []),
        ],
        tools: ["codemode", "read"],
        conversation: [
          assistantMessage([toolCall({ id: "parent", name: "codemode", arguments: { code } })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Done")]),
        ],
      }).run("List the synthetic computer's windows in Codemode.");
      expect(getToolExecution(run, "parent").isError).toBe(false);
      const following = run.providerRequests[1]?.messages as Message[];
      const result = following.find(
        (message) => message.role === "toolResult" && message.toolCallId === "parent",
      );
      expect(result?.content).toContainEqual({
        type: "text",
        text: `\n\n---\n\n# Guide: ${guide.id}\n\n${guide.markdown}`,
      });
      const lines = run.tuiRenderedOutput.split("\n").map((line) => line.trim());
      const output = lines.indexOf(computerResult);
      expect(output).toBeGreaterThan(-1);
      const nextLine = lines.slice(output + 1).find(Boolean);
      expect(nextLine).toMatch(/\b\d+(?:\.\d+)?s\b/u);
      expect(lines).not.toContain(guide.markdown);
    });
  },
);
