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
    { name: "presenter.txt", effect: "applied", status: "Saved · post-write step failed" },
    { name: "post-handler.txt", effect: "unknown", status: "Effects unknown · edit failed" },
  ] as const)(`reports execution failure honestly in ${mode}: $name`, async (fixture) => {
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
      const source = `.tmp/execution-failure/${fixture.name}`;
      await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
      await writeFile(path.join(cwd, source), "before\n");
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
        testName: `execution-failure-${mode}-${fixture.name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/support/execution-failure-presenter.ts"),
        ],
        tools: ["write", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Failure observed.")]),
        ],
      }).run("Keep confirmed writes separate from unconfirmed execution effects");
      expect(getToolExecution(run, "failed").isError).toBe(mode === "standalone");
      expect(await readFile(path.join(cwd, source), "utf8")).toBe("changed\n");
      if (fixture.effect === "unknown")
        expect(
          await readFile(path.join(cwd, ".tmp/execution-failure/unreported.txt"), "utf8"),
        ).toBe("peer\n");
      else {
        const events = (
          await readFile(path.join(cwd, ".tmp/execution-failure/events.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { content: string });
        expect(events).toEqual([expect.objectContaining({ content: "changed\n" })]);
      }
      if (mode === "standalone")
        expect(getToolExecutionDetails(getToolExecution(run, "failed"))).toMatchObject({
          effect: fixture.effect,
        });
      expect(getToolResultText(run, "failed")).not.toContain("No file was changed.");
      expect(getToolResultText(run, "failed")).not.toContain("Failed: INVALID_REQUEST");
      expect(run.tuiRenderedOutput).toContain(fixture.status);
    });
  });
}
