import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test.each([false, true])(
  "Native Codemode processes each Write and the final Replace once, even after a later failure=%s",
  async (fail) => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
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
          "builtin:codemode",
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/support/final-post-edit-extension.ts"),
        ],
        tools: ["codemode", "read", "write", "replace", "copy", "move", "delete"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "edit",
                name: "codemode",
                arguments: {
                  code: `
const check = result => { if(typeof result!=="string") throw Error("Expected readable result"); return result; };
check(await tools.write({path:"a.note",content:"first"}));
check(await tools.write({path:"b.note",content:"second"}));
const seen=check(await tools.read({path:"a.note"}));
if(!seen.endsWith("FIRST")) throw Error("Write did not finish formatting");
check(await tools.replace({path:"a.note",start:"FIRST",text:"final"}));
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
      // Each Write finishes immediately; the later Replace has its own final processing.
      expect((await events("format-events.jsonl")).map((event) => event.content).sort()).toEqual([
        "final",
        "first",
        "second",
      ]);
      expect(
        (await events("diagnostic-events.jsonl")).map((event) => event.content).sort(),
      ).toEqual(["FINAL", "FIRST", "SECOND"]);
    });
  },
);

test.each(["path", "result"] as const)(
  "failed final processing keeps applied effects without an old final snapshot for %s input",
  async (input) => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      await writeFile(path.join(cwd, "a.note"), "anchor\nTAIL\n");
      await writeFile(path.join(cwd, "b.note"), "anchor\nTAIL\n");
      const run = await new PiIntegrationTest({
        testName: `final-post-edit-failed-resource-${input}`,
        rawMode: false,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          "builtin:codemode",
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/support/final-post-edit-extension.ts"),
          path.resolve("tests/integration/support/post-edit-external-change.ts"),
        ],
        tools: ["codemode", "insert", "read", "post_edit_external_change"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "edit",
                name: "codemode",
                arguments: {
                  code: `
${input === "result" ? 'const selected = await tools.read({path:"a.note",offset:1,limit:1});' : ""}
await Promise.all([
  ${input === "result" ? 'tools.insert({path:selected,text:"A"})' : 'tools.insert({path:"a.note",anchor:"anchor",text:"A"})'},
  tools.insert({path:"b.note",anchor:"anchor",text:"B"})
]);
await tools.read({path:"a.note"});
await tools.post_edit_external_change({path:"a.note",content:"EXTERNAL\\n"});
`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Finished without replaying confirmed writes.")]),
        ],
      }).run("Keep final-processing failure separate from applied writes");
      expect(getToolExecution(run, "edit").isError).toBe(true);
      expect(await readFile(path.join(cwd, "a.note"), "utf8")).toBe("EXTERNAL\n");
      expect(await readFile(path.join(cwd, "b.note"), "utf8")).toBe("ANCHOR\nB\nTAIL\n");
      expect(getToolExecutionResult(run, "edit")).toMatchObject({
        details: {
          editorBatchResults: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({ effect: "applied" }) as unknown,
            }),
          ]) as unknown,
        },
      });
      const saved = await PiRun.open(run.artifacts.run);
      const entry = saved.session
        ?.split("\n")
        .find((line) => line.includes('"customType":"ide-nested-results"'));
      const panel = JSON.parse(entry ?? "{}") as {
        data: {
          calls: Array<{
            name: string;
            args: { path?: string };
            result?: {
              isError?: boolean;
              details?: { results?: Array<{ data: Record<string, unknown> }> };
            };
          }>;
        };
      };
      const failure = panel.data.calls.find(
        (call) =>
          call.name === "insert" &&
          call.result?.details?.results?.some(
            (item) => typeof item.data.path === "string" && item.data.path.endsWith("a.note"),
          ),
      );
      expect(failure?.result?.isError).toBe(true);
      const data = failure?.result?.details?.results?.[0]?.data;
      expect(data).toMatchObject({ ok: false, errors: [{ code: "POST_EDIT_FAILED" }] });
      expect(data).not.toHaveProperty("afterContent");
      expect(data).not.toHaveProperty("afterDocument");
    });
  },
);
test("whole-file operations finalize only surviving text targets and preserve binary bytes", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
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
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/final-post-edit-extension.ts"),
      ],
      tools: ["codemode", "read", "write", "replace", "copy", "move", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "files",
              name: "codemode",
              arguments: {
                code: `
const check = result => { if(typeof result!=="string") throw Error("Expected readable result"); return result; };
check(await tools.copy({path:"source.note",target:"temporary.note"}));
check(await tools.move({path:"temporary.note",target:"final.note"}));
check(await tools.copy({path:"source.note",target:"discard.note"}));
check(await tools.delete({path:"discard.note"}));
check(await tools.copy({path:"binary.note",target:"binary-copy.note"}));
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
