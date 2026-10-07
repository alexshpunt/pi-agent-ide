import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { textResultChecks } from "#integration/support/text-result-checks.js";

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
                code:
                  textResultChecks +
                  `const written=await tools.write({path:"empty.txt",content:""});
check(written.includes("not yet applied"),"Write did not report acceptance");
const read=await tools.read({path:written});
check(body(read)==="[Empty source.]","Read did not explain the empty source");
const point=await tools.select({path:read,operation:{kind:"position",edge:"after"}});
check(items(point).length===1 && items(point)[0].startColumn===0,"Empty source boundary lost");
text(point);`,
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
        expect(getToolExecutionResult(run, "create")).not.toHaveProperty("structuredContent");
        expect(getToolResultText(run, "create")).toContain("empty.txt");
      } else {
        const details = getToolExecutionDetails(getToolExecution(run, "create")) as {
          editorBatchResults: {
            status: string;
            data: { effect: string; files: { source: string; effect: string }[] };
          }[];
        };
        expect(details.editorBatchResults).toHaveLength(1);
        const receipt = details.editorBatchResults[0];
        if (!receipt) throw new Error("Missing automatic commit receipt");
        expect(receipt.status).toBe("success");
        expect(receipt.data.effect).toBe("applied");
        expect(
          receipt.data.files.map(({ source, effect }) => ({
            source: path.basename(source),
            effect,
          })),
        ).toEqual([{ source: "empty.txt", effect: "applied" }]);
      }
      expect(await readFile(path.join(cwd, "empty.txt"))).toEqual(Buffer.alloc(0));
      expect(await readFile(path.join(cwd, "protected.txt"), "utf8")).toBe("😀 protected\r\n");
      expect(getToolResultText(run, "create")).not.toContain(
        "Text changes must change the document.",
      );
    });
  });
}
