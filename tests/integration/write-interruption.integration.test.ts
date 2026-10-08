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

for (const name of ["before-save.note", "after-save.note", "unknown.note"] as const) {
  test(`retains an honest final interruption result for ${name}`, async () => {
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
      const source = `.tmp/write-interruption/${name}`;
      await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
      await writeFile(path.join(cwd, source), "before\n");
      const run = await new PiIntegrationTest({
        testName: `write-interruption-${name}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/support/write-interruption-probe.ts"),
        ],
        tools: ["write", "read", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "interrupted",
                name: "codemode",
                arguments: {
                  code: `// @options: {"timeout_ms":2000}\ntext(await tools.write({path:${JSON.stringify(source)},content:"changed\\n"}));`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Interruption observed.")]),
        ],
      }).run("Keep saved bytes separate from interrupted processing and unknown history");
      const expected = name === "after-save.note" ? "changed\n" : "before\n";
      expect(getToolExecution(run, "interrupted").isError).toBe(true);
      expect(await readFile(path.join(cwd, source), "utf8")).toBe(expected);
      const events = (
        await readFile(path.join(cwd, ".tmp/write-interruption/events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stage: string; aborted: boolean; content: string });
      if (name === "unknown.note") {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ stage: "guard-start", content: expected });
      } else {
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({ aborted: true, content: expected });
      }
      expect(getToolResultText(run, "interrupted")).toMatch(/interrupted/i);
      expect(run.tuiRenderedOutput).toMatch(/interrupted/i);
      expect(run.tuiRenderedOutput).not.toContain("Result unavailable in this saved display.");
      expect(run.tuiRenderedOutput).not.toContain("Nested IDE display:");
      if (name === "unknown.note") {
        expect(run.tuiRenderedOutput).toContain("Effects unknown · edit failed");
        expect(run.tuiRenderedOutput).not.toContain("Not changed · edit failed");
      } else if (name === "before-save.note") {
        // The late guard result confirms no write before the parent history is saved.
        expect(run.tuiRenderedOutput).toContain("Not changed · edit failed");
      }
    });
  });
}

test("keeps deferred processing complete when its handler finishes after a script deadline", async () => {
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
    const source = ".tmp/write-interruption/after-save.note";
    await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
    await writeFile(path.join(cwd, source), "before\n");
    const run = await new PiIntegrationTest({
      testName: "replace-interrupted-processing",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/support/write-interruption-probe.ts"),
      ],
      tools: ["read", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "interrupted",
              name: "codemode",
              arguments: {
                code: `// @options: {"timeout_ms":2000}\nconst source = await tools.read({path:${JSON.stringify(source)}}); text(await tools.replace({path:source,text:"changed\\n"})); while(true){}`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Saved edit observed.")]),
      ],
    }).run("Do not call deferred processing interrupted when it actually finishes");
    expect(getToolExecution(run, "interrupted").isError).toBe(true);
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("changed\n");
    const events = (await readFile(path.join(cwd, ".tmp/write-interruption/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { aborted: boolean; content: string });
    expect(events).toHaveLength(2);
    expect(events.every((event) => !event.aborted && event.content === "changed\n")).toBe(true);
    expect(getToolResultText(run, "interrupted")).not.toMatch(
      /post-edit processing was interrupted/i,
    );
    expect(run.tuiRenderedOutput).not.toContain("Result unavailable in this saved display.");
  });
});
for (const ending of ["deadline", "ordinary-error"] as const) {
  test(`keeps a completed Write complete after a later ${ending}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      const run = await new PiIntegrationTest({
        testName: `write-completed-${ending}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["write", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "ended",
                name: "codemode",
                arguments: {
                  code: `// @options: {"timeout_ms":2000}\ntext(await tools.write({path:"completed.txt",content:"saved\\n"}));\n${ending === "deadline" ? "while(true){}" : 'throw Error("ordinary fixture error");'}`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Completed write observed.")]),
        ],
      }).run("Do not reclassify a completed Write when later script work fails");
      expect(getToolExecution(run, "ended").isError).toBe(true);
      expect(await readFile(path.join(cwd, "completed.txt"), "utf8")).toBe("saved\n");
      expect(getToolResultText(run, "ended")).not.toMatch(/post-edit processing was interrupted/i);
      expect(run.tuiRenderedOutput).not.toContain("Result unavailable in this saved display.");
    });
  });
}
