import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

// Models often send an empty string for an optional selector they mean to omit. A single
// direct call, a batch of direct calls in one message and native Codemode take separate paths.
test("empty optional anchors act as omitted on single, batched and Codemode calls", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    const files = ["single", "batched", "delete", "copy", "script"];
    for (const name of files)
      await writeFile(path.join(cwd, `${name}.txt`), "alpha\nbeta\ngamma\n");
    const replace = (id: string, file: string) =>
      toolCall({
        id,
        name: "replace",
        arguments: { path: `${file}.txt`, start: "beta", end: "", text: "BETA" },
      });
    const result = await new PiIntegrationTest({
      testName: "empty-optional-anchor",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: ["builtin:codemode", path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace", "delete", "copy", "codemode"],
      conversation: [
        assistantMessage([replace("single", "single")], { stopReason: "toolUse" }),
        assistantMessage(
          [
            replace("batched", "batched"),
            toolCall({
              id: "delete",
              name: "delete",
              arguments: { path: "delete.txt", start: "beta", end: "" },
            }),
            toolCall({
              id: "copy",
              name: "copy",
              arguments: {
                path: "copy.txt",
                start: "alpha",
                target: "copy.txt",
                targetStart: "gamma",
                targetEnd: "",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: 'text(await tools.replace({path:"script.txt",start:"beta",end:"",text:"BETA"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply the supplied edits.");
    for (const id of files) expect(getToolExecution(result, id).isError).toBe(false);
    for (const file of ["single", "batched", "script"])
      expect(await readFile(path.join(cwd, `${file}.txt`), "utf8")).toBe("alpha\nBETA\ngamma\n");
    expect(await readFile(path.join(cwd, "delete.txt"), "utf8")).toBe("alpha\ngamma\n");
    expect(await readFile(path.join(cwd, "copy.txt"), "utf8")).toBe("alpha\nbeta\ngamma\nalpha\n");
  });
}, 120_000);
