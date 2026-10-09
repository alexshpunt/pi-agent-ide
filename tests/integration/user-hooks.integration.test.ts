import { readFile, writeFile } from "node:fs/promises";
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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

test("file hooks block resolved access and report saved-edit feedback", async () => {
  await withTempWorkspace(async (cwd) => {
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "secret.txt"), "do not expose");
    await writeFile(path.join(cwd, "locked.txt"), "unchanged");
    await writeFile(path.join(cwd, "throw.txt"), "hidden");
    await writeFile(path.join(cwd, "fail-edit.txt"), "unchanged");
    const run = await new PiIntegrationTest({
      testName: "user-file-hooks",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/user-hooks-extension.ts"),
      ],
      tools: ["read", "codemode", "write", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "read-secret", name: "read", arguments: { path: "secret.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-raw-secret",
              name: "read",
              arguments: { path: "raw:secret.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-script-secret",
              name: "codemode",
              arguments: {
                code: 'let blocked=""; try { await tools.read({path:"secret.txt"}); } catch(error) { blocked=String(error); } if(!blocked.includes("fixture secret")) throw Error("Blocked read must reject"); text(blocked);',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "read-throw", name: "read", arguments: { path: "throw.txt" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "edit-locked",
              name: "codemode",
              arguments: {
                code: 'text(await tools.replace({path:"locked.txt",start:"unchanged",text:"changed"}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-review",
              name: "write",
              arguments: { path: "review.txt", content: "needs review" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-after-fail",
              name: "write",
              arguments: { path: "after.txt", content: "explode-after" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Exercise each file hook");

    expect(getToolExecution(run, "read-secret").isError).toBe(true);
    expect(getToolResultText(run, "read-secret")).toContain("fixture secret");
    expect(getToolExecution(run, "read-raw-secret").isError).toBe(true);
    expect(getToolResultText(run, "read-raw-secret")).toContain("fixture secret");
    expect(getToolExecution(run, "read-script-secret").isError).toBe(false);
    expect(getToolResultText(run, "read-script-secret")).toContain("fixture secret");
    expect(getToolExecution(run, "read-throw").isError).toBe(true);
    expect(getToolResultText(run, "read-throw")).toContain("read hook exploded");
    // A caught Read rejection can continue; a blocked batch commit fails the parent script.
    expect(getToolExecution(run, "edit-locked").isError).toBe(true);
    expect(getToolResultText(run, "edit-locked")).toContain("fixture lock");
    expect(await readFile(path.join(cwd, "locked.txt"), "utf8")).toBe("unchanged");
    expect(getToolExecution(run, "write-review").isError).toBe(false);
    expect(await readFile(path.join(cwd, "review.txt"), "utf8")).toBe("needs review");
    expect(getToolResultText(run, "write-review")).not.toContain("Saved edit needs review");
    expect(getToolResultText(run, "write-review")).toContain(
      "Post-edit processing was interrupted or incomplete.",
    );
    expect(run.tuiRenderedOutput).toContain("Saved edit needs review");
    expect(getToolExecution(run, "write-after-fail").isError).toBe(false);
    expect(await readFile(path.join(cwd, "after.txt"), "utf8")).toBe("explode-after");
    expect(getToolResultText(run, "write-after-fail")).toContain(
      "Post-edit processing was interrupted or incomplete.",
    );
    expect(run.tuiRenderedOutput).toContain("failed after the edit was saved");
  });
});
