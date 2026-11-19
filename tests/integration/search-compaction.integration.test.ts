import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { afterEach, expect, test } from "vitest";

const workspaces: string[] = [];

const issuedReferenceProvider = path.resolve(
  "tests/integration/fixtures/issued-reference-provider.ts",
);

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each(["numbered", "all"] as const)(
  "edits every repeated line after compact Search using %s references",
  async (selection) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-compaction-edit-"));
    workspaces.push(cwd);
    await mkdir(path.join(cwd, ".pi-agent"));
    await writeFile(path.join(cwd, "task.txt"), "keep1\nOLD\nkeep2\nOLD\nkeep3\nOLD\n");

    const result = await new PiIntegrationTest({
      testName: `search-compaction-edit-${selection}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [issuedReferenceProvider, path.resolve("src/pi-agent-ide.ts")],
      tools: ["search", "insert"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "compact",
              name: "search",
              arguments: { query: "OLD", path: "task.txt", limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...(selection === "numbered"
          ? [
              assistantMessage(
                [
                  toolCall({
                    id: "details",
                    name: "search",
                    arguments: { query: "OLD", path: "task.txt", limit: 3 },
                  }),
                ],
                { stopReason: "toolUse" },
              ),
            ]
          : []),
        assistantMessage(
          (selection === "numbered" ? [1, 2, 3] : ["all"]).map((index) =>
            toolCall({
              id: `insert-${index}`,
              name: "insert",
              arguments: {
                path:
                  selection === "numbered"
                    ? `$issued-search:details:${index}`
                    : "$issued-searchallline:compact",
                before: true,
                newText: "ADDED",
              },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Insert ADDED before every OLD line using the issued Search selections");

    expect(getToolExecutionDetails(getToolExecution(result, "compact"))).toMatchObject({
      payload: {
        matchCount: 3,
        complete: true,
        storedFiles: [
          { matchCount: 3, uniqueLineCount: 1, groups: [{ matchCount: 3 }], lines: [] },
        ],
      },
    });
    if (selection === "numbered") {
      expect(getToolExecutionDetails(getToolExecution(result, "details"))).toMatchObject({
        payload: {
          matchCount: 3,
          complete: true,
          storedFiles: [
            {
              lines: [
                [2, expect.anything(), [{ from: 0, to: 3 }]],
                [4, expect.anything(), [{ from: 0, to: 3 }]],
                [6, expect.anything(), [{ from: 0, to: 3 }]],
              ],
            },
          ],
        },
      });
    }
    for (const index of selection === "numbered" ? [1, 2, 3] : ["all"]) {
      expect(getToolExecution(result, `insert-${index}`).isError).toBe(false);
    }
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
      "keep1\nADDED\nOLD\nkeep2\nADDED\nOLD\nkeep3\nADDED\nOLD\n",
    );
  },
);
test("text search keeps a complete selection while compacting repeated details", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-search-compaction-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, ".pi-agent"));
  await writeFile(path.join(cwd, "large.txt"), "same needle\n".repeat(100));

  const result = await new PiIntegrationTest({
    testName: "search-compaction",
    rawMode: false,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
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
