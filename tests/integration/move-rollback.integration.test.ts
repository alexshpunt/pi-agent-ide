import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

for (const native of [false, true]) {
  for (const scenario of [
    "restored",
    "target-failed",
    "target-failed-after-restore",
    "source-failed",
  ] as const) {
    test(`${native ? "native" : "immediate"} Move keeps per-resource ${scenario} rollback evidence`, async () => {
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
        const directory = ".tmp/move-rollback";
        await mkdir(path.join(cwd, directory), { recursive: true });
        const source = `${directory}/${scenario}-source.txt`;
        const target = `${directory}/${scenario}-target.txt`;
        await writeFile(path.join(cwd, source), "head\nmove-me\nend\n");
        await writeFile(path.join(cwd, target), "top\nbottom\n");
        const parameters = { path: source, start: "move-me", target, targetStart: "top" };
        const peer = `${directory}/peer.txt`;
        const hasPeer = native && scenario === "target-failed";
        if (hasPeer) await writeFile(path.join(cwd, peer), "OLD\n");
        const peerCode = hasPeer
          ? `await tools.replace({path:${JSON.stringify(peer)},start:"OLD",text:"CONFIRMED"}); await tools.read({path:${JSON.stringify(peer)}});`
          : "";
        const run = await new PiIntegrationTest({
          testName: `move-rollback-${native ? "native" : "immediate"}-${scenario}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          rawMode: false,
          tuiSize: { cols: 120, rows: hasPeer ? 160 : 70 },
          cwd,
          extensions: [
            path.resolve("src/pi-agent-ide.ts"),
            "builtin:codemode",
            path.resolve(
              hasPeer
                ? "benchmarks/tool-capabilities/move-rollback-fixture.ts"
                : "tests/integration/support/move-rollback-resource.ts",
            ),
          ],
          tools: ["move", "replace", "codemode"],
          conversation: [
            assistantMessage(
              [
                toolCall({
                  id: "move",
                  name: native ? "codemode" : "move",
                  arguments: native
                    ? { code: `${peerCode} text(await tools.move(${JSON.stringify(parameters)}));` }
                    : parameters,
                }),
              ],
              { stopReason: "toolUse" },
            ),
            ...(hasPeer
              ? [
                  assistantMessage(
                    [
                      toolCall({
                        id: "observe",
                        name: "codemode",
                        arguments: {
                          code: `text(await tools.read({path:${JSON.stringify(source)}})); text(await tools.read({path:${JSON.stringify(target)}}));`,
                        },
                      }),
                    ],
                    { stopReason: "toolUse" },
                  ),
                ]
              : []),
            assistantMessage([text("Move failure observed; no retry.")]),
          ],
        }).run("Report Move rollback outcomes without guessing final bytes");
        expect(getToolExecution(run, "move").isError).toBe(true);
        const sourceEffect = scenario === "source-failed" ? "unknown" : "not-applied";
        const targetEffect = scenario.startsWith("target-failed") ? "unknown" : "not-applied";
        const effect = scenario === "restored" ? "not-applied" : "unknown";
        const uncertain =
          scenario === "restored" ? [] : [scenario === "source-failed" ? source : target];
        const restored = [source, target].filter((file) => !uncertain.includes(file));
        const receipt = {
          effect,
          files: expect.arrayContaining([
            { source: expect.stringContaining(source) as unknown, effect: sourceEffect },
            { source: expect.stringContaining(target) as unknown, effect: targetEffect },
          ]) as unknown,
        };
        expect(getToolExecutionResult(run, "move")).toMatchObject(
          native
            ? {
                details: {
                  editorBatchResults: expect.arrayContaining([
                    expect.objectContaining({
                      data: expect.objectContaining(receipt) as unknown,
                    }) as unknown,
                  ]) as unknown,
                },
              }
            : {
                details: {
                  effect,
                  results: [
                    {
                      data: {
                        rollback: {
                          failedSources: uncertain.map(
                            (file) => expect.stringContaining(file) as unknown,
                          ),
                          restoredSources: restored.map(
                            (file) => expect.stringContaining(file) as unknown,
                          ),
                        },
                      },
                    },
                  ],
                },
              },
        );
        const output = getToolResultText(run, "move");
        expect(output).not.toContain("Completed writes:");
        if (hasPeer) {
          expect(await readFile(path.join(cwd, peer), "utf8")).toBe("CONFIRMED\n");
          expect(getToolExecutionResult(run, "move")).toMatchObject({
            details: {
              editorBatchResults: expect.arrayContaining([
                expect.objectContaining({
                  data: expect.objectContaining({
                    effect: "applied",
                    files: [
                      { source: expect.stringContaining(peer) as unknown, effect: "applied" },
                    ],
                  }) as unknown,
                }) as unknown,
              ]) as unknown,
            },
          });
          expect(run.tuiRenderedOutput).toContain("CONFIRMED");
          const task = capabilityCases.find((item) => item.id === "move-rollback-target-failed");
          if (!task) throw Error("Missing Move rollback capability case");
          const events = run.traceEvents.flatMap((entry) =>
            "event" in entry && entry.event && typeof entry.event === "object"
              ? [entry.event as RunEvent]
              : [],
          );
          expect(validateRoute(task, events, "codemode")).toEqual({ passed: true, reasons: [] });
        }
        if (scenario !== "restored") {
          expect(output).not.toContain("No file was changed.");
          expect(output).toContain(scenario === "source-failed" ? source : target);
        }
        expect(run.tuiRenderedOutput).toContain(
          scenario === "restored"
            ? "Rolled back · write failed"
            : "State unknown · rollback failed",
        );
        if (scenario !== "restored")
          expect(run.tuiRenderedOutput).toContain(
            path.basename(scenario === "source-failed" ? source : target),
          );
        expect(await readFile(path.join(cwd, source), "utf8")).toBe(
          scenario === "source-failed" ? "head\nend\n" : "head\nmove-me\nend\n",
        );
        expect(await readFile(path.join(cwd, target), "utf8")).toBe(
          scenario === "target-failed" ? "top\nmove-me\nbottom\n" : "top\nbottom\n",
        );
        // The paid fixture does not create attempt logs; its route and final bytes are checked above.
        if (hasPeer) return;
        const attempts = (await readFile(path.join(cwd, directory, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { file: string; attempt: number; content: string });
        expect(
          attempts
            .filter((item) => path.basename(item.file) === path.basename(source))
            .map(({ attempt, content }) => ({ attempt, content })),
        ).toEqual([
          { attempt: 1, content: "head\nend\n" },
          { attempt: 2, content: "head\nmove-me\nend\n" },
        ]);
        expect(
          attempts
            .filter((item) => path.basename(item.file) === path.basename(target))
            .map(({ attempt, content }) => ({ attempt, content })),
        ).toEqual([
          { attempt: 1, content: "top\nmove-me\nbottom\n" },
          { attempt: 2, content: "top\nbottom\n" },
        ]);
      });
    });
  }
}
