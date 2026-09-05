import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { afterAll, expect, test } from "vitest";

const searchCore = path.resolve("src/extensions/pi-agent-search/index.ts");
const hangingSearch = path.resolve(
  "tests/integration/extensions/pi-agent-search/fixtures/hanging-search-extension.ts",
);
const tempRoot = path.resolve(".agents", "tmp", "search-timeout-integration");
await mkdir(tempRoot, { recursive: true });

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("returns a scoped timeout error from the real search tool", async () => {
  const directory = await mkdtemp(path.join(tempRoot, "project-"));
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, "search.json"),
    JSON.stringify({ timeoutMs: 20 }),
    "utf8",
  );

  const callId = "timed-search";
  const result = await new PiIntegrationTest({
    artifactsDir: testArtifactsDir(import.meta.filename),
    testName: "configured-search-timeout",
    cwd: directory,
    extensions: [
      searchCore,
      hangingSearch,
      path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts"),
    ],
    tools: ["search"],
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: callId,
            name: "search",
            arguments: { query: "hang forever", path: "/" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("The search was narrowed after the timeout.")]),
    ],
  }).run("Run the intentionally broad search");

  expect(getToolExecution(result, callId).isError).toBe(true);
  expect(getToolResultText(result, callId)).toContain(
    "Search timed out after 20ms. Try a smaller path scope.",
  );
});
