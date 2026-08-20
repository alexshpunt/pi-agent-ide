import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, beforeAll, expect, test } from "vitest";

const temporaryDirectory = path.resolve(".agents", "tmp", "unified-extension-integration");
const configPath = path.join(temporaryDirectory, "pi-agent-ide.json");
const ideExtensionPath =
  process.env.PI_AGENT_IDE_TEST_EXTENSION ?? path.resolve("src/pi-agent-ide.ts");
const externalPluginPath =
  process.env.PI_AGENT_IDE_TEST_EXTERNAL_PLUGIN ??
  path.resolve("tests/integration/composite/support/external-search-plugin.ts");

beforeAll(async () => {
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      disabledExtensions: ["search.text", "search.semantic", "search.web"],
    }),
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("loads one IDE extension, applies its config, and accepts an external plugin", async () => {
  const externalCall = "external-search";
  const disabledCall = "disabled-search";
  const result = await new PiIntegrationTest({
    testName: "unified-extension-external-plugin",
    extensions: [ideExtensionPath, externalPluginPath],
    environment: { PI_AGENT_IDE_CONFIG: configPath },
    tools: ["search"],
    conversation: [
      assistantMessage(
        [toolCall({ id: externalCall, name: "search", arguments: { query: "external:test" } })],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [toolCall({ id: disabledCall, name: "search", arguments: { query: "semantic:test" } })],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Use the external search plugin, then try disabled semantic search");

  expect(getToolExecution(result, externalCall).isError).toBe(false);
  expect(getToolResultText(result, externalCall)).toContain("External plugin connected.");
  expect(getToolResultMessage(result, disabledCall).details).toMatchObject({
    failure: { code: "NO_RESOLVER" },
  });
  expect(getToolResultText(result, disabledCall)).toContain("No search resolver handled");
});
