import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.each([false, true])(
  "Apply processes final files once, even after a later failure=%s",
  async (fail) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const run = await new PiIntegrationTest({
        testName: `final-post-edit-${fail}`,
        rawMode: false,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/support/final-post-edit-extension.ts"),
        ],
        tools: ["apply", "read"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "edit",
                name: "apply",
                arguments: {
                  source: `
write({path:"a.note",content:"first"});
if(read({path:"a.note"}).content!=="first") throw new Error("formatted too early");
replace({path:"a.note",start:"first",text:"final"});
write({path:"b.note",content:"second"});
${fail ? 'throw new Error("planned failure");' : ""}
`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "check-a", name: "read", arguments: { path: "diagnostics:a.note" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "check-b", name: "read", arguments: { path: "diagnostics:b.note" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Edit two files and check their final diagnostics");
      expect(getToolExecution(run, "edit").isError).toBe(fail);
      expect(await readFile(path.join(cwd, "a.note"), "utf8")).toBe("FINAL");
      expect(await readFile(path.join(cwd, "b.note"), "utf8")).toBe("SECOND");
      for (const id of ["check-a", "check-b"]) {
        const execution = getToolExecution(run, id);
        expect(execution.isError, JSON.stringify(execution)).toBe(false);
        expect(getToolExecutionDetails(execution)).toMatchObject({
          diagnosticCheck: { complete: true, count: 0, sources: ["fixture-check"] },
        });
      }
      const events = async (file: string) =>
        (await readFile(path.join(cwd, file), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { content: string });
      expect((await events("format-events.jsonl")).map((event) => event.content)).toEqual([
        "final",
        "second",
      ]);
      expect(
        (await events("diagnostic-events.jsonl")).map((event) => event.content).sort(),
      ).toEqual(["FINAL", "SECOND"]);
    });
  },
);

test("whole-file operations finalize only surviving text targets and preserve binary bytes", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await writeFile(path.join(cwd, "source.note"), "copied");
    const binary = Buffer.from([0, 255, 13, 10]);
    await writeFile(path.join(cwd, "binary.note"), binary);
    const run = await new PiIntegrationTest({
      testName: "final-file-operations",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/final-post-edit-extension.ts"),
      ],
      tools: ["apply", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "files",
              name: "apply",
              arguments: {
                source: `
copy_file({path:"source.note",target:"temporary.note"});
move_file({path:"temporary.note",target:"final.note"});
copy_file({path:"source.note",target:"discard.note"});
delete_file({path:"discard.note"});
copy_file({path:"binary.note",target:"binary-copy.note"});
`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "check", name: "read", arguments: { path: "diagnostics:final.note" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Copy and move text and binary files");
    expect(getToolExecution(run, "files").isError).toBe(false);
    expect(await readFile(path.join(cwd, "source.note"), "utf8")).toBe("copied");
    expect(await readFile(path.join(cwd, "final.note"), "utf8")).toBe("COPIED");
    expect(await readFile(path.join(cwd, "binary-copy.note"))).toEqual(binary);
    const events = (await readFile(path.join(cwd, "format-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string });
    expect(events.map((event) => path.basename(event.path))).toEqual(["final.note"]);
  });
});
