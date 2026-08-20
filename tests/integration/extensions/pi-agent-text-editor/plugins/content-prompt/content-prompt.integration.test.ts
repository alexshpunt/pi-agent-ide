import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  testArtifactsDir,
  text,
} from "pi-coding-agent-test";
import { afterAll, beforeAll, expect, test } from "vitest";

import { generateContentPromptExtensions } from "#integration/extensions/pi-agent-text-editor/plugins/content-prompt/support/generate-content-prompt-extensions.js";

const generatedExtensions = await generateContentPromptExtensions();
const cwd = path.resolve(".tmp/pi-agent-text-editor-content-prompt");
const expectedSection = [
  "- Text edits support these writable resources:",
  "  - `filesystem` — Writes local filesystem paths.",
  "    - `text` — UTF-8 text.",
  "",
  "write supports these installed extensions:",
  "  - `write-pipeline` — Adds fixture write behavior.",
].join("\n");

beforeAll(() => mkdir(cwd, { recursive: true }));
afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(cwd, { recursive: true, force: true });
});

test("assembles installed writable content types beside tool descriptions", async () => {
  const result = await runPrompt("content-prompt-write-active", ["write"]);
  const prompt = getProviderSystemPrompt(result);

  expect(prompt).toContain(expectedSection);
  expect(prompt.match(/Text edits support these writable resources:/gu)).toHaveLength(1);
  expect(prompt.match(/write supports these installed extensions:/gu)).toHaveLength(1);
  expect(prompt).not.toContain("`image`");
});

test("omits writable content types when no registered editor tool is selected", async () => {
  const result = await runPrompt("content-prompt-write-inactive", []);
  expect(getProviderSystemPrompt(result)).not.toContain(
    "Text edits support these writable resources:",
  );
});

function runPrompt(testName: string, tools: readonly string[]) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName,
    cwd,
    extensions: generatedExtensions.paths,
    tools,
    conversation: [assistantMessage([text("The writable content prompt was inspected")])],
  }).run("Inspect installed writable content types");
}
