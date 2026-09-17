import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const temporaryDirectory = path.resolve(".agents", "tmp", "preset-integration");
const configPath = path.join(temporaryDirectory, ".pi", "pi-agent-ide", "extensions.json");
const ideExtensionPath =
  process.env.PI_AGENT_IDE_TEST_EXTENSION ?? path.resolve("src/pi-agent-ide.ts");

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("text editor preset loads editing tools without terminal, debugger, or vision", async () => {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ preset: "text-editor" }));
  await writeFile(path.join(temporaryDirectory, "note.txt"), "alpha\n");

  const result = await new PiIntegrationTest({
    testName: "text-editor-preset",
    extensions: [ideExtensionPath],
    cwd: temporaryDirectory,
    tools: ["read", "search", "write"],
    conversation: [
      assistantMessage(
        [toolCall({ id: "read-note", name: "read", arguments: { path: "note.txt" } })],
        { stopReason: "toolUse" },
      ),
      assistantMessage(
        [
          toolCall({
            id: "write-next",
            name: "write",
            arguments: { path: "next.txt", content: "beta\n" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("done")]),
    ],
  }).run("Use text editor preset tools");

  expect(getToolExecution(result, "read-note").isError).toBe(false);
  expect(getToolResultText(result, "read-note")).toContain("alpha");
  expect(getToolExecution(result, "write-next").isError).toBe(false);
  const prompt = getProviderSystemPrompt(result);
  expect(prompt).toContain("read:");
  expect(prompt).toContain("write:");
  expect(prompt).toContain("search:");
  expect(prompt).not.toContain("bash:");
  expect(prompt).not.toContain("debug:");
  expect(prompt).not.toContain("inspect_tui:");
});
