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

test.each([
  { initial: "old\nold\n", final: "new\nnew\n", remaining: 0 },
  { initial: "old old\n", final: "new old\n", remaining: 2 },
])(
  "search replacements retain effects and report $remaining remaining matches",
  async (scenario) => {
    const root = path.resolve(".agents/tmp/grouped-receipts");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      for (const file of ["a.txt", "b.txt"])
        await writeFile(path.join(cwd, file), scenario.initial);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true, noPostProcessing: true }),
      );
      const result = await new PiIntegrationTest({
        testName: "grouped-search-receipts",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve(
            "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
          ),
        ],
        tools: ["search", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search",
                name: "search",
                arguments: { query: '"old"', include: "*.txt" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace",
                name: "replace",
                arguments: { path: "SEARCH#RUNTIME:1:all:match", text: "new" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Apply the supplied replacement.");
      expect(getToolExecution(result, "replace").isError).toBe(false);
      for (const file of ["a.txt", "b.txt"])
        expect(await readFile(path.join(cwd, file), "utf8")).toBe(scenario.final);
      expect(getToolExecutionDetails(getToolExecution(result, "replace"))).toMatchObject({
        searchObservations: [{ query: '"old"', matches: scenario.remaining, complete: true }],
      });
      await writeFile(
        path.join(result.artifacts.directory, "receipt.txt"),
        getToolResultText(result, "replace"),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
