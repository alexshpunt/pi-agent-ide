import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.each(["evaluate", "late"] as const)(
  "public debugger %s returns the current stopped-frame state",
  async (phase) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const program = "subtotal = 1\nimport time\ntime.sleep(1)\nsubtotal += 2\nprint(subtotal)\n";
      await writeFile(path.join(cwd, "contract.py"), program);
      const run = await new PiIntegrationTest({
        testName: `debugger-current-${phase}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/support/debugger-state-fixture.ts"),
        ],
        tools: ["read", "debug", "insert", "delete", "check_debugger_state"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "state", name: "check_debugger_state", arguments: { phase } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Verify debugger state through public tools");
      expect(getToolExecution(run, "state").isError, getToolResultText(run, "state")).toBe(false);
      expect(getToolExecutionResult(run, "state")).toMatchObject({
        details: {
          pending: { metadata: { semanticAction: { verified: false } } },
          started: {
            metadata: {
              semanticAction: {
                status: "stopped",
                breakpoints: (phase === "late" ? [2, 4] : [4]).map(
                  (line) => expect.objectContaining({ line, verified: true }) as unknown,
                ),
              },
            },
          },
          evaluated: {
            metadata: {
              semanticAction: {
                status: "stopped",
                evaluation: { result: phase === "evaluate" ? "2" : "1" },
                stop: {
                  frame: { line: 4 },
                  variables: expect.arrayContaining([
                    expect.objectContaining({
                      name: "subtotal",
                      value: phase === "evaluate" ? "2" : "1",
                    }),
                  ]) as unknown,
                },
              },
            },
          },
        },
      });
    });
  },
);
