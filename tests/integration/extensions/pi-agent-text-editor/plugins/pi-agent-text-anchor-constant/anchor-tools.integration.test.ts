import { readFile } from "node:fs/promises";
import path from "node:path";

import { getProviderSystemPrompt, getToolExecution } from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import {
  expectTextToolDiff,
  runTextToolScenario,
} from "#integration/support/pi-runtime/scenario.js";

const extensions = await createExtensionSet();
afterAll(() => extensions.dispose());

const content = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

describe("constant anchors through text editor tools", () => {
  test("inserts after begin", async () => {
    await runConstantScenario(
      "constant-insert",
      "insert",
      { anchor: "begin", text: "inserted" },
      ["alpha", "inserted", "bravo", "charlie", "delta", "echo"].join("\n"),
    );
  });

  test("replaces the line selected by begin", async () => {
    await runConstantScenario(
      "constant-replace",
      "replace",
      { start: "begin", end: "begin", text: "replaced" },
      ["replaced", "bravo", "charlie", "delta", "echo"].join("\n"),
    );
  });

  test("deletes the line selected by end", async () => {
    await runConstantScenario(
      "constant-delete",
      "delete",
      { start: "end", end: "end" },
      ["alpha", "bravo", "charlie", "delta"].join("\n"),
    );
  });

  test("copies begin after end", async () => {
    await runConstantScenario(
      "constant-copy",
      "copy",
      { start: "begin", end: "begin", targetStart: "end" },
      ["alpha", "bravo", "charlie", "delta", "echo", "alpha"].join("\n"),
    );
  });

  test("cuts begin after end", async () => {
    await runConstantScenario(
      "constant-move",
      "move",
      { start: "begin", end: "begin", targetStart: "end" },
      ["bravo", "charlie", "delta", "echo", "alpha"].join("\n"),
    );
  });
});

async function runConstantScenario(
  testName: string,
  tool: "insert" | "replace" | "delete" | "copy" | "move",
  arguments_: Record<string, unknown>,
  expectedContent: string,
): Promise<void> {
  await withTempWorkspace(async (directory) => {
    const file = await createFixture(directory, `${tool}.txt`, content);
    const relativeFile = path.relative(directory, file);
    const toolArguments =
      tool === "copy" || tool === "move"
        ? { path: relativeFile, target: relativeFile, ...arguments_ }
        : { path: relativeFile, ...arguments_ };
    const scenario = await runTextToolScenario({
      extensions: extensions.paths,
      cwd: directory,
      testName,
      tool,
      arguments: toolArguments,
    });
    const { result, mutationCallId } = scenario;
    const systemPrompt = getProviderSystemPrompt(result);

    expect(systemPrompt).toContain("Text editor anchors:");
    expect(systemPrompt).toContain("- `begin` and `end` select the first and last existing lines.");
    expect(getToolExecution(result, mutationCallId).isError).toBe(false);
    expectTextToolDiff(scenario, relativeFile, content, expectedContent);
    await expect(readFile(file, "utf8")).resolves.toBe(expectedContent);
  });
}
