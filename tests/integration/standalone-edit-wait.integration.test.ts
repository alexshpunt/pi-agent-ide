import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("six standalone replacements survive a slow edit of the same file", async () => {
  await withTempWorkspace(async (cwd) => {
    const file = "parallel.txt";
    const slots = ["apple", "banana", "cherry", "date", "elderberry", "fig"];
    const original = slots.map((slot) => `[old ${slot}]`).join("\r\n");
    await writeFile(path.join(cwd, file), original);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
    );
    const calls = slots.map((slot) => ({
      id: `edit-${slot}`,
      name: "replace",
      arguments: { path: file, at: `old ${slot}`, text: `new ${slot}` },
    }));
    const result = await new PiIntegrationTest({
      cwd,
      testName: "standalone-edit-wait",
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      extensions: [
        path.resolve("tests/integration/fixtures/slow-first-edit.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          calls.map((entry) => toolCall(entry)),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace all six markers in one batch.");
    for (const { id } of calls)
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(await readFile(path.join(cwd, "saved-edits.txt"), "utf8")).toBe("1\n2\n3\n4\n5\n6\n");
    expect(await readFile(path.join(cwd, file), "utf8")).toBe(
      "[new apple]\r\n[new banana]\r\n[new cherry]\r\n[new date]\r\n[new elderberry]\r\n[new fig]",
    );
  });
});
