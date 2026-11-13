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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { textResultChecks } from "#integration/support/text-result-checks.ts";

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
check(typeof written==="string" && written.startsWith("RESULT#"),"Write did not resolve to the id of the empty file: "+written);
const read=await tools.read({path:written});
// The script gets the exact empty text; the "[Empty source.]" notice is for direct reads.
check(read?.text==="" && read.id.startsWith("RESULT#"),"Read of the empty file was not exactly empty");
text(written);`,
              },
            });
      const run = await new PiIntegrationTest({
        testName: `empty-write-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "write", "codemode"],
        conversation: [
          assistantMessage([call], { stopReason: "toolUse" }),
          assistantMessage([text("Empty file creation finished.")]),
        ],
      }).run("Create an empty file and verify its actual effect without changing its neighbors");
      expect(getToolExecution(run, "create").isError, getToolResultText(run, "create")).toBe(false);
      if (mode === "standalone") {
        expect(getToolExecutionResult(run, "create")).not.toHaveProperty("structuredContent");
        expect(getToolResultText(run, "create")).toContain("empty.txt");
      }
      expect(await readFile(path.join(cwd, "empty.txt"))).toEqual(Buffer.alloc(0));
      expect(await readFile(path.join(cwd, "protected.txt"), "utf8")).toBe("😀 protected\r\n");
      expect(getToolResultText(run, "create")).not.toContain(
        "Text changes must change the document.",
      );
    });
  });
}
