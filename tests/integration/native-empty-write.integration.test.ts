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

for (const mode of ["standalone", "codemode"] as const) {
  test(`creates an empty file with truthful effects and a usable target in ${mode}`, async () => {
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
      await writeFile(path.join(cwd, "protected.txt"), "😀 protected\r\n");
      const call =
        mode === "standalone"
          ? toolCall({ id: "create", name: "write", arguments: { path: "empty.txt", content: "" } })
          : toolCall({
              id: "create",
              name: "codemode",
              arguments: {
                code: `const written=await tools.write({path:"empty.txt",content:""});
if(written.status!=="success"||written.data.effect!=="pending"||!written.data.target) throw Error(JSON.stringify(written));
const committed=await tools.flush({});
if(committed.status!=="success"||committed.data.effect!=="applied"||committed.data.operations.length!==1||committed.data.operations[0].effect!=="applied") throw Error(JSON.stringify(committed));
const read=await tools.read({path:written.data.target});
if(read.status!=="success"||!read.data.target) throw Error(JSON.stringify(read));
const point=await tools.select({path:read.data.target,operation:{kind:"position",edge:"after"}});
if(point.status!=="success"||point.data.totalItems!==1||point.data.items[0].range.startColumn!==0) throw Error(JSON.stringify(point));
text({effect:committed.data.effect,target:written.data.target,point:point.data.items[0].range});`,
              },
            });
      const run = await new PiIntegrationTest({
        testName: `empty-write-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "write", "select", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Empty file creation finished.")]),
        ],
      }).run("Create an empty file and verify its actual effect without changing its neighbors");
      expect(getToolExecution(run, "create").isError, getToolResultText(run, "create")).toBe(false);
      if (mode === "standalone") {
        expect(getToolExecutionResult(run, "create")).toMatchObject({
          structuredContent: {
            status: "success",
            data: { effect: "applied" },
          },
        });
      }
      expect(await readFile(path.join(cwd, "empty.txt"))).toEqual(Buffer.alloc(0));
      expect(await readFile(path.join(cwd, "protected.txt"), "utf8")).toBe("😀 protected\r\n");
      expect(getToolResultText(run, "create")).not.toContain(
        "Text changes must change the document.",
      );
    });
  });
}
