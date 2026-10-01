import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
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

test("native Codemode preserves the original snapshot for sequential editor calls and guards stale anchors", async () => {
  await withTempWorkspace(async (cwd) => {
    const initial = "alpha\nbeta\ngamma\nomega\n";
    await writeFile(path.join(cwd, "note.txt"), initial);
    const insert = {
      path: "note.txt",
      anchor: formatLineHashAnchor(1, "alpha"),
      before: true,
      text: "added",
    };
    const replace = {
      path: "note.txt",
      start: formatLineHashAnchor(2, "beta"),
      text: "BETA",
    };
    const remove = { path: "note.txt", start: formatLineHashAnchor(3, "gamma") };
    const code = `text(await tools.read({path:"note.txt",views:["anchors"]}));
text(await tools.insert(${JSON.stringify(insert)}));
text(await tools.replace(${JSON.stringify(replace)}));
text(await tools.delete(${JSON.stringify(remove)}));`;
    const run = await new PiIntegrationTest({
      testName: "native-codemode-sequential-snapshot",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "insert", "replace", "delete", "codemode"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "sequential-edits", name: "codemode", arguments: { code } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Run sequential insert, replace and delete calls using the original file anchors");
    const execution = getToolExecution(run, "sequential-edits");
    const shown = getToolResultText(run, "sequential-edits");
    const final = await readFile(path.join(cwd, "note.txt"), "utf8");

    // A blocked stale anchor must leave the earlier edit intact without changing another line.
    if (execution.isError) {
      expect(shown).toContain(`start anchor "${replace.start}" is stale`);
      expect(shown).toContain("insert (ok), replace (error)");
      expect(final).toBe("added\n" + initial);
    }

    // Stale-anchor protection does not satisfy the requested sequential batch contract.
    expect(execution.isError, shown).toBe(false);
    expect(final).toBe("added\nalpha\nBETA\nomega\n");
  });
});
