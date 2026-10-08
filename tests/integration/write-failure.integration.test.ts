import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

for (const mode of ["standalone", "codemode"] as const) {
  test.each([
    { name: "rollback-ok.txt", before: "before\n", after: "before\n", effect: "not-applied" },
    { name: "rollback-failed.txt", before: "before\n", after: "changed\n", effect: "unknown" },
    { name: "rollback-new.txt", before: undefined, after: "", effect: "unknown" },
  ] as const)(`reports real write-failure consequences in ${mode}: $name`, async (fixture) => {
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
      const source = `.tmp/write-failure/${fixture.name}`;
      await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
      if (fixture.before !== undefined) await writeFile(path.join(cwd, source), fixture.before);
      const call =
        mode === "standalone"
          ? toolCall({
              id: "failed",
              name: "write",
              arguments: { path: source, content: "changed\n" },
            })
          : toolCall({
              id: "failed",
              name: "codemode",
              arguments: {
                code: `try { await tools.write({path:${JSON.stringify(source)},content:"changed\\n"}); throw Error("Unsafe success"); } catch(error) { if (String(error).includes("Unsafe success")) throw error; text(String(error)); }`,
              },
            });
      const run = await new PiIntegrationTest({
        testName: `write-failure-${mode}-${fixture.name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/support/write-failure-resource.ts"),
        ],
        tools: ["write", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Failure observed.")]),
        ],
      }).run(
        "Report rollback consequences without claiming an unchanged file or replaying the write",
      );
      expect(getToolExecution(run, "failed").isError).toBe(mode === "standalone");
      expect(await readFile(path.join(cwd, source), "utf8")).toBe(fixture.after);
      if (mode === "standalone")
        expect(getToolExecutionDetails(getToolExecution(run, "failed"))).toMatchObject({
          effect: fixture.effect,
        });
      if (fixture.effect === "unknown") {
        expect(getToolResultText(run, "failed")).not.toContain("No file was changed.");
        expect(getToolResultText(run, "failed")).not.toContain("Completed writes:");
        expect(run.tuiRenderedOutput).toContain("State unknown · rollback failed");
      } else {
        expect(run.tuiRenderedOutput).toContain("Rolled back · write failed");
      }
      const attempts = (await readFile(path.join(cwd, ".tmp/write-failure/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { attempt: number; content: string });
      expect(attempts).toEqual([
        expect.objectContaining({ attempt: 1, content: "changed\n" }),
        expect.objectContaining({ attempt: 2, content: fixture.before ?? "" }),
      ]);
    });
  });
}

test("the shared Replace path does not claim a failed rollback was unapplied", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const source = ".tmp/write-failure/rollback-failed.txt";
    await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
    await writeFile(path.join(cwd, source), "before\n");
    const run = await new PiIntegrationTest({
      testName: "replace-failed-rollback-effect",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/write-failure-resource.ts"),
      ],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "failed",
              name: "replace",
              arguments: { path: source, start: "before", text: "changed" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Failure observed.")]),
      ],
    }).run("Report uncertain effects consistently for a shared text mutation");
    expect(getToolExecution(run, "failed").isError).toBe(true);
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("changed\n");
    expect(getToolExecutionDetails(getToolExecution(run, "failed"))).toMatchObject({
      effect: "unknown",
    });
    expect(getToolResultText(run, "failed")).not.toContain("No file was changed.");
    expect(run.tuiRenderedOutput).toContain("State unknown · rollback failed");
  });
});
