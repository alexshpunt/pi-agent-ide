import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  testArtifactsDir,
  text,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-filesystem");

await mkdir(tempRoot, { recursive: true });
const cwd = await mkdtemp(path.join(tempRoot, "content-description-"));

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(cwd, { recursive: true, force: true });
});

test("does not advertise filesystem reads without an installed content adapter", async () => {
  const result = await new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName: "filesystem-prompt-without-content",
    cwd,
    extensions: generatedExtensions.paths,
    tools: ["read"],
    conversation: [assistantMessage([text("The prompt was inspected")])],
  }).run("Inspect the filesystem provider prompt");

  expect(getProviderSystemPrompt(result)).not.toContain("Read supports these installed protocols:");
});
