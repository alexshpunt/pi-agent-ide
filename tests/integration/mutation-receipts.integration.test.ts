import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

test("batched receipts describe successful operations without counting rejected edits", async () => {
  const root = path.resolve(".agents/tmp/mutation-receipts");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "batch-"));
  try {
    await writeFile(path.join(cwd, "example.txt"), "first\nsecond\nthird\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    const result = await new PiIntegrationTest({
      testName: "mutation-receipts-batch",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace", "insert"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "replace",
              name: "replace",
              arguments: { path: "example.txt", start: "first", text: "updated" },
            }),
            toolCall({
              id: "insert",
              name: "insert",
              arguments: { path: "example.txt", anchor: "third", text: "fourth" },
            }),
            toolCall({
              id: "rejected",
              name: "replace",
              arguments: { path: "example.txt", start: "absent", text: "bad" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply the supplied independent edits.");
    expect(await readFile(path.join(cwd, "example.txt"), "utf8")).toBe(
      "updated\nsecond\nthird\nfourth\n",
    );
    expect(getToolExecution(result, "rejected").isError).toBe(true);
    for (const operation of ["replace", "insert"]) {
      expect(getToolExecutionDetails(getToolExecution(result, operation))).toMatchObject({
        results: [
          { data: { operations: [{ operation, changes: 1 }], formatting: { status: "disabled" } } },
        ],
      });
    }
    await writeFile(
      path.join(result.artifacts.directory, "receipt.txt"),
      getToolResultText(result, "insert"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
