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
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

for (const native of [false, true]) {
  for (const [scenario, effect, finalText] of [
    ["restored", "not-applied", "KEEP\n"],
    ["failed", "unknown", "KEEP\nNEW"],
    ["failed-after-restore", "unknown", "KEEP\n"],
  ] as const) {
    test(`${native ? "native" : "standalone"} Insert reports ${scenario} rollback without guessing effects`, async () => {
      await withTempWorkspace(async (cwd) => {
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/settings.json"),
          JSON.stringify({ codemode: { mode: "on" } }),
        );
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
        );
        const source = `rollback-${scenario}.txt`;
        const parameters = { path: source, anchor: "KEEP", text: "NEW" };
        const run = await new PiIntegrationTest({
          testName: `rollback-${native ? "native" : "standalone"}-${scenario}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          rawMode: false,
          cwd,
          extensions: [
            path.resolve("src/pi-agent-ide.ts"),
            "builtin:codemode",
            path.resolve("tests/integration/support/rollback-resource.ts"),
          ],
          tools: ["insert", "codemode", "rollback_state"],
          conversation: [
            assistantMessage(
              [
                toolCall({
                  id: "edit",
                  name: native ? "codemode" : "insert",
                  arguments: native
                    ? { code: `text(await tools.insert(${JSON.stringify(parameters)}));` }
                    : parameters,
                }),
              ],
              { stopReason: "toolUse" },
            ),
            assistantMessage([toolCall({ id: "state", name: "rollback_state", arguments: {} })], {
              stopReason: "toolUse",
            }),
            assistantMessage([text("Rollback review finished.")]),
          ],
        }).run("Observe write failures and actual rollback outcomes without retries");
        expect(getToolExecution(run, "edit").isError).toBe(true);
        const result = getToolExecutionResult(run, "edit");
        expect(getToolResultText(run, "edit")).toContain(
          "Injected write failure after changing bytes",
        );
        if (native) {
          expect(result).toMatchObject({
            details: {
              editorBatchResults: [
                {
                  data: {
                    effect,
                    files: [{ effect }],
                    operations: [
                      {
                        effect,
                        errors: [
                          {
                            code: "WRITE_FAILED",
                            message: expect.stringContaining(
                              "Injected write failure after changing bytes",
                            ) as unknown,
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          });
        } else {
          expect(result).toMatchObject({ details: { effect } });
        }
        if (native) {
          const saved = await PiRun.open(run.artifacts.run);
          const panel = saved.session
            ?.split("\n")
            .find((line) => line.includes('"customType":"ide-nested-results"'));
          expect(panel).toBeDefined();
          expect(JSON.parse(panel ?? "{}")).toMatchObject({
            data: {
              calls: [
                {
                  result: {
                    isError: true,
                    details: {
                      results: [
                        {
                          data: {
                            rollback: {
                              failedSources:
                                scenario === "restored" ? [] : [expect.any(String) as unknown],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          });
        }
        const state = JSON.parse(getToolResultText(run, "state")) as {
          source: string;
          text: string;
          writes: string[];
        }[];
        expect(state.find((item) => item.source === source)).toEqual({
          source,
          text: finalText,
          writes: ["KEEP\nNEW", "KEEP\n"],
        });
      });
    });
  }
}
