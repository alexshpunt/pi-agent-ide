import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("the shared Replace result keeps formatting separate from an ordinary edit", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = ".tmp/post-edit-demo/unchanged.note";
    await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
    await writeFile(path.join(cwd, source), "before\n");
    const run = await new PiIntegrationTest({
      testName: "replace-formatting-unchanged",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/write-formatting-probe.ts"),
      ],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "formatted",
              name: "replace",
              arguments: { path: source, start: "before", text: "after" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Replacement formatted.")]),
      ],
    }).run("Keep ordinary edit counts and other checks while reporting already-formatted content");
    expect(getToolExecution(run, "formatted").isError, getToolResultText(run, "formatted")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("after\n");
    expect(getToolResultText(run, "formatted")).toContain("Already formatted (fixture).");
    expect(getToolResultText(run, "formatted")).toContain("Extra check finished");
    expect(getToolResultText(run, "formatted")).toContain("1 text change(s)");
    expect(getToolResultText(run, "formatted")).not.toContain("Formatting:");
    expect(run.tuiRenderedOutput).toContain("Already formatted (fixture)");
  });
});
for (const mode of ["standalone", "codemode"] as const) {
  test.each([
    {
      name: "changed.note",
      final: "AFTER\n",
      summary: "Formatted (fixture).",
      footer: "Formatted (fixture)",
    },
    {
      name: "unchanged.note",
      final: "after\n",
      summary: "Already formatted (fixture).",
      footer: "Already formatted (fixture)",
    },
    {
      name: "failed.note",
      final: "after\n",
      summary: "Formatting failed (fixture).",
      footer: "Formatting failed (fixture)",
    },
    {
      name: "unavailable.txt",
      final: "after\n",
      summary: "No formatter is available for this file.",
      footer: undefined,
    },
  ])(
    `reports formatting once without losing saved text or other statuses in ${mode}: $name`,
    async (fixture) => {
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
        const source = `.tmp/post-edit-demo/${fixture.name}`;
        await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
        await writeFile(path.join(cwd, source), "before\n");
        const checks = `const result=await tools.write({path:${JSON.stringify(source)},content:"after\\n"});
if(!result.includes(${JSON.stringify(fixture.summary)})) throw Error("Missing formatting outcome: "+result);
if(result.includes("Formatting:")) throw Error("Duplicate raw formatting status: "+result);
if(!result.includes(${JSON.stringify(fixture.final.trim())})) throw Error("Missing saved final text: "+result);
${fixture.name.endsWith(".note") ? 'if(!result.includes("Extra check finished")) throw Error("Lost another handler status: "+result); if(((result.split("\\n---\\n")[0]||"").match(/formatted|formatting failed/gi)||[]).length!==1) throw Error("Repeated formatting report: "+result);' : ""}
text("Formatting checked.");`;
        const run = await new PiIntegrationTest({
          testName: `write-formatting-${mode}-${fixture.name}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          rawMode: false,
          extensions: [
            path.resolve("src/pi-agent-ide.ts"),
            "builtin:codemode",
            path.resolve("tests/integration/support/write-formatting-probe.ts"),
          ],
          tools: ["write", "codemode"],
          conversation: [
            assistantMessage(
              [
                mode === "standalone"
                  ? toolCall({
                      id: "formatted",
                      name: "write",
                      arguments: { path: source, content: "after\n" },
                    })
                  : toolCall({ id: "formatted", name: "codemode", arguments: { code: checks } }),
              ],
              { stopReason: "toolUse" },
            ),
            assistantMessage([text("Formatting observed.")]),
          ],
        }).run("Separate the saved file from its formatter outcome on both surfaces");
        expect(
          getToolExecution(run, "formatted").isError,
          getToolResultText(run, "formatted"),
        ).toBe(false);
        expect(await readFile(path.join(cwd, source), "utf8")).toBe(fixture.final);
        if (mode === "standalone") {
          const result = getToolResultText(run, "formatted");
          expect(result).toContain(fixture.summary);
          expect(result).not.toContain("Formatting:");
          expect(result.split(fixture.summary)).toHaveLength(2);
          if (fixture.name.endsWith(".note")) {
            expect(result).toContain("Extra check finished");
            const receipt = result.split("\n---\n")[0] ?? "";
            expect(receipt.match(/formatted|formatting failed/gi)).toHaveLength(1);
          }
        }
        if (fixture.footer !== undefined) expect(run.tuiRenderedOutput).toContain(fixture.footer);
        if (fixture.name === "unchanged.note")
          expect(run.tuiRenderedOutput).not.toContain("· Formatted (fixture)");
        if (fixture.name.endsWith(".note")) {
          expect(run.tuiRenderedOutput).toContain("Extra check finished");
          const events = (
            await readFile(path.join(cwd, ".tmp/post-edit-demo/events.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { saved: string; final: string });
          expect(events).toEqual([
            expect.objectContaining({ saved: "after\n", final: fixture.final }),
          ]);
        }
      });
    },
  );
}
