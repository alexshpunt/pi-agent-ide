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
import { textResultChecks } from "#integration/support/text-result-checks.js";

for (const mode of ["on", "only"] as const) {
  test(`Write results select the final whole file after formatting in Codemode ${mode}`, async () => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ codemode: { mode } }));
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const source = ".tmp/post-edit-demo/changed.note";
      const code =
        textResultChecks +
        `
const created=await tools.write({path:${JSON.stringify(source)},content:"first\\nsecond\\n"});
check(body(await tools.read({path:created}))==="FIRST\\nSECOND\\n","Creation lost the formatted whole-file target");
check(matches(await tools.search({path:created,query:"SECOND"})).length===1,"Search cannot consume creation");
check(items(await tools.select({path:created,operation:{kind:"lines",first:1,last:2}})).length===1,"Select lost the whole-file boundary");
const overwritten=await tools.write({path:created,content:"😀 unique\\r\\nunique tail"});
check(body(await tools.read({path:overwritten}))==="😀 UNIQUE\\r\\nUNIQUE TAIL","Overwrite lost final UTF16/CRLF text");
const found=await tools.search({path:overwritten,query:"UNIQUE"});
check(matches(found).length===2,"Search lost part of the final whole file");
const noop=await tools.write({path:overwritten,content:"😀 UNIQUE\\r\\nUNIQUE TAIL"});
check(body(await tools.read({path:noop}))==="😀 UNIQUE\\r\\nUNIQUE TAIL","No-op lost the final snapshot");
await tools.replace({path:matches(found)[0],text:"FINAL"});
await rejects(()=>tools.read({path:overwritten}));
await rejects(()=>tools.replace({path:overwritten,text:"WRONG"}));
text(created); text(noop);`;
      const run = await new PiIntegrationTest({
        testName: `write-final-target-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/support/write-formatting-probe.ts"),
        ],
        tools: ["write", "read", "search", "select", "replace", "codemode"],
        conversation: [
          assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Final Write targets checked.")]),
        ],
      }).run("Compose the final Write snapshot directly while refusing retired targets");
      expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
        false,
      );
      expect(await readFile(path.join(cwd, source), "utf8")).toBe("😀 FINAL\r\nUNIQUE TAIL");
      const events = (await readFile(path.join(cwd, ".tmp/post-edit-demo/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { final: string });
      expect(events.map((event) => event.final)).toEqual([
        "FIRST\nSECOND\n",
        "😀 UNIQUE\r\nUNIQUE TAIL",
        "😀 FINAL\r\nUNIQUE TAIL",
      ]);
    });
  });
}

test("a NUL-containing Write keeps the same Read target when repeated unchanged", async () => {
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
    const code =
      textResultChecks +
      `
const created=await tools.write({path:"nul.txt",content:"A\\0B"});
check(body(await tools.read({path:created}))==="A\\0B","Creation lost NUL bytes");
const noop=await tools.write({path:created,content:"A\\0B"});
check(body(await tools.read({path:noop}))==="A\\0B","No-op lost the supported text target");
text(noop);`;
    const run = await new PiIntegrationTest({
      testName: "write-final-target-nul",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "composed", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Repeated Write target checked.")]),
      ],
    }).run("Keep a supported Write snapshot usable after an identical-content call");
    expect(getToolExecution(run, "composed").isError, getToolResultText(run, "composed")).toBe(
      false,
    );
    expect(await readFile(path.join(cwd, "nul.txt"))).toEqual(Buffer.from([0x41, 0, 0x42]));
  });
});

test("standalone Write publishes the formatted whole-file target", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = ".tmp/post-edit-demo/changed.note";
    const run = await new PiIntegrationTest({
      testName: "write-final-target-standalone",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/write-formatting-probe.ts"),
      ],
      tools: ["write"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "written",
              name: "write",
              arguments: { path: source, content: "lowercase\n" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Formatted target observed.")]),
      ],
    }).run("Return a usable target for the final standalone Write snapshot");
    expect(getToolExecution(run, "written").isError, getToolResultText(run, "written")).toBe(false);
    expect(await readFile(path.join(cwd, source), "utf8")).toBe("LOWERCASE\n");
    const details = getToolExecutionDetails(getToolExecution(run, "written"));
    expect(details).toHaveProperty("metadata.resultTarget");
  });
});
