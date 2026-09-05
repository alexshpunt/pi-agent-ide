import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

const tempRoot = path.resolve(".agents", "tmp", "web-prefix-removal");
const searchExtensions = [
  path.resolve("src/extensions/pi-agent-search/index.ts"),
  path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts"),
];

await mkdir(tempRoot, { recursive: true });
const workspace = await mkdtemp(path.join(tempRoot, "project-"));

await writeFile(path.join(workspace, "notes.txt"), "web:standalone ownership marker\n", "utf8");

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("treats the removed web prefix as ordinary local text", async () => {
  const callId = "literal-web-prefix";
  const result = await new PiIntegrationTest({
    artifactsDir: testArtifactsDir(import.meta.filename),
    testName: "literal-web-prefix-is-local-text",
    cwd: workspace,
    extensions: searchExtensions,
    tools: ["search"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "search",
            arguments: { query: "web:standalone ownership marker" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("The local search finished.")]),
    ],
  }).run("Find the literal local text beginning with web:");

  const execution = getToolExecution(result, callId);
  expect(execution.isError).toBe(false);
  expect(getToolExecutionDetails(execution)).toMatchObject({ resolverId: "text" });
  expect(getToolResultText(result, callId)).toContain("notes.txt");
  expect(getToolResultText(result, callId)).toContain("web:standalone ownership marker");
});
