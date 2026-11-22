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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";

// Cover single selections and lone destination insertion on each route.
test("single selectors and destination insertion work on all routes", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    const files = ["single", "batched", "delete", "copy", "script"];
    for (const name of files)
      await writeFile(path.join(cwd, `${name}.txt`), "alpha\nbeta\ngamma\n");
    const replace = (id: string, file: string) =>
      toolCall({
        id,
        name: "replace",
        arguments: { path: `${file}.txt`, at: "beta", text: "BETA" },
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
              // A literal selects only its characters; include the break to delete the line.
              arguments: { path: "delete.txt", at: "beta\n" },
            }),
            toolCall({
              id: "copy",
              name: "copy",
              arguments: {
                path: "copy.txt",
                at: "alpha\n",
                target: "copy.txt",
                targetAfter: "gamma\n",
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
                code: 'text(await tools.replace({path:"script.txt",at:"beta",text:"BETA"}));',
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
