import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const restoreRuntime = forceStandaloneIntegrationFile();
afterAll(restoreRuntime);
const extension = path.resolve("src/pi-agent-ide.ts");
const workspace = path.resolve(".tmp/pi-agent-filesystem-jq");
const jqAvailable = spawnSync("jq", ["--version"], { windowsHide: true }).status === 0;

test.skipIf(!jqAvailable)("queries JSON through a parameterized jq view", async () => {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "users.json"),
    JSON.stringify({
      users: [
        { id: 1, name: "Ada", active: true },
        { id: 2, name: "Lin", active: false },
      ],
    }),
  );

  const result = await new PiIntegrationTest({
    testName: "filesystem-jq-view",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: workspace,
    extensions: [extension],
    tools: ["read"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "jq-read",
            name: "read",
            arguments: {
              path: "users.json",
              views: ["jq:.users[] | select(.active) | {id, name}"],
            },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: "jq-page",
            name: "read",
            arguments: { path: "users.json", views: ["jq:.users"], offset: 2, limit: 2 },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: "jq-error",
            name: "read",
            arguments: { path: "users.json", views: ["jq:.users | invalid("] },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Read active users with jq");

  expect(getToolExecution(result, "jq-read").isError).toBe(false);
  const message = getToolResultMessage(result, "jq-read");
  const output = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(output).toContain('"name": "Ada"');
  expect(output).not.toContain('"name": "Lin"');
  const page = getToolResultMessage(result, "jq-page");
  expect(page.details).toMatchObject({ startLine: 2, endLine: 3 });
  expect(getToolExecution(result, "jq-error").isError).toBe(true);
});
