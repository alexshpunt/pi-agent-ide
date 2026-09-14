import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("text search keeps a complete selection while compacting repeated details", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-compaction-"));
  workspaces.push(cwd);
  await writeFile(path.join(cwd, "large.txt"), "same needle\n".repeat(100));

  const result = await new PiIntegrationTest({
    testName: "search-compaction",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["search"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "search",
            name: "search",
            arguments: { query: "needle", path: "large.txt", limit: 5 },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Search the large file");

  const execution = getToolExecution(result, "search");
  expect(execution.isError).toBe(false);
  expect(getToolExecutionDetails(execution)).toMatchObject({
    payload: {
      matchCount: 100,
      fileCount: 1,
      complete: true,
      storedFiles: [
        {
          matchCount: 100,
          uniqueLineCount: 1,
          groups: [{ matchCount: 100 }],
          lines: [],
        },
      ],
    },
  });
});
