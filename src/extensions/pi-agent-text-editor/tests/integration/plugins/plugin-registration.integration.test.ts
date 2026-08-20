import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  testArtifactsDir,
  text,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import {
  ASYNC_CORE_FIRST_DESCRIPTION,
  ASYNC_PLUGIN_FIRST_DESCRIPTION,
  generatePluginRegistrationExtensions,
  SYNC_DESCRIPTION,
} from "#tests/integration/test-stand/generate-plugin-registration-extensions.js";

const generatedExtensions = await generatePluginRegistrationExtensions();
afterAll(() => generatedExtensions.dispose());

test("registers text editor plugins in both extension load orders", async () => {
  const result = await new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: "text-editor-plugin-registration",
    cwd: path.resolve(".tmp/pi-agent-text-editor"),
    extensions: generatedExtensions.paths,
    tools: ["write"],
    conversation: [assistantMessage([text("Plugin registration finished")])],
  }).run("Check the installed text editor extensions");
  const prompt = getProviderSystemPrompt(result);

  expect(prompt).toContain("# Text Editor Tools Extensions");
  expect(prompt).toContain(`- \`asynchronous-plugin-first\` — ${ASYNC_PLUGIN_FIRST_DESCRIPTION}`);
  expect(prompt).toContain(`- \`asynchronous-core-first\` — ${ASYNC_CORE_FIRST_DESCRIPTION}`);
  expect(prompt).toContain(`- \`synchronous-plugin\` — ${SYNC_DESCRIPTION}`);
  expect(prompt.match(/# Text Editor Tools Extensions/g)).toHaveLength(1);
});
