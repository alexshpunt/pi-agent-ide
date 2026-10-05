import { mkdir, writeFile } from "node:fs/promises";
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

test("uses Search frames for file lists and readonly process records without changing data", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noPostProcessing: true }),
    );
    await writeFile(path.join(cwd, "a.ts"), "function task() { probe(); }\r\n");
    const scripts = [
      `const r=await tools.search({query:"files:*.ts"}); if(typeof r!=="string" || !r.includes("a.ts")) throw Error(r); text({fileCount:1});`,
      `const r=await tools.search({query:${JSON.stringify(`process:${process.pid}`)}}); if(typeof r!=="string" || !r.includes(String(${process.pid}))) throw Error(r); text({readonlyProcess:true});`,
    ];
    const run = await new PiIntegrationTest({
      testName: "search-list-style",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "codemode"],
      conversation: [
        ...scripts.map((code, index) =>
          assistantMessage(
            [toolCall({ id: `style-${index}`, name: "codemode", arguments: { code } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Search presentation finished.")]),
      ],
    }).run("Inspect file and process results through native Search");
    for (let index = 0; index < scripts.length; index++)
      expect(
        getToolExecution(run, `style-${index}`).isError,
        getToolResultText(run, `style-${index}`),
      ).toBe(false);
    expect(run.tuiRenderedOutput).toContain("╭─ 1 file");
    expect(run.tuiRenderedOutput).toContain("TS");
    expect(run.tuiRenderedOutput).toContain("a.ts");
    expect(run.tuiRenderedOutput).toContain("╭─ 1 processes shown");
    expect(run.tuiRenderedOutput).toContain(String(process.pid));
  });
});
