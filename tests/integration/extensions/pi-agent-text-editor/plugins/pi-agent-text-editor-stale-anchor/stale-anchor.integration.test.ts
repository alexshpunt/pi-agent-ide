import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const extensions = createExtensionSet();
const fresh = formatLineHashAnchor("alpha\nbeta", 1);
const staleAnchorExtension = path.join(
  process.cwd(),
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts",
);
afterAll(() => extensions.dispose());

async function runInsert(directory: string, callId: string, anchor: string) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: callId,
    cwd: directory,
    extensions: [...extensions.paths, staleAnchorExtension],
    tools: ["insert"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "insert",
            arguments: { path: "subject.txt", anchor, text: "inserted" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Insert text");
}

describe("pi-agent-text-editor stale anchor", () => {
  test("allows a fresh line anchor", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "subject.txt");
      await writeFile(file, "alpha\nbeta", "utf8");
      const result = await runInsert(directory, "fresh-anchor", fresh);

      expect(getToolExecution(result, "fresh-anchor").isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\ninserted\nbeta");
    });
  });

});
