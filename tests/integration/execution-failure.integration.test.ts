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
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

for (const mode of ["standalone", "codemode"] as const) {
  test.each([
    // Presenters run only for results that show fresh LINE#HASH anchors.
    {
      name: "presenter.txt",
      tool: "replace",
      edit: { start: formatLineHashAnchor(1, "before"), text: "changed" },
      effect: "applied",
      status: "Saved · post-write step failed",
    },
    {
      name: "post-handler.txt",
      tool: "write",
      edit: { content: "changed\n" },
      effect: "unknown",
      status: "Effects unknown · edit failed",
    },
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
              name: fixture.tool,
              arguments: { path: source, ...fixture.edit },
            })
          : toolCall({
              id: "failed",
              name: "codemode",
              arguments: {
                // Script edits commit after the script, so only Write fails inside it.
                code:
                  fixture.tool === "write"
                    ? `try { await tools.write(${JSON.stringify({ path: source, ...fixture.edit })}); throw Error("Unsafe success"); } catch(error) { if (String(error).includes("Unsafe success")) throw error; text(String(error)); }`
                    : `await tools.${fixture.tool}(${JSON.stringify({ path: source, ...fixture.edit })});`,
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
        tools: ["write", "replace", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Failure observed.")]),
        ],
      }).run("Keep confirmed writes separate from unconfirmed execution effects");
      // A script that catches the Write failure succeeds; a failed script edit batch fails it.
      expect(getToolExecution(run, "failed").isError).toBe(
        mode === "standalone" || fixture.tool !== "write",
      );
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
        // Script batches present again after deferred final processing.
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) expect(event).toMatchObject({ content: "changed\n" });
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
