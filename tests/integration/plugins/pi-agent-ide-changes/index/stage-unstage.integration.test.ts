import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import { requiredValue } from "pi-agent-invariant";
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

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const runFile = promisify(execFile);
const extensions = createExtensionSet();
const changesExtension = path.resolve("src/plugins/pi-agent-ide-changes/index.ts");
const fileName = "tracked.txt";
const baseline = "alpha\nbeta\ngamma\n";
const current = "alpha\nBETA\ngamma\n";

const selector = requiredValue(
  createChangeGroups(fileName, baseline, baseline, current)[0],
).selector;

afterAll(() => extensions.dispose());

test("stages and unstages one change, then removes a staged change with undo", async () => {
  await withTempWorkspace(async (directory) => {
    const file = path.join(directory, fileName);
    await initializeRepository(directory, file);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "stage-unstage-change",
      cwd: directory,
      extensions: [...extensions.paths, changesExtension],
      tools: ["stage", "unstage", "read", "undo"],
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        toolMessage("stage-change", "stage", { file: fileName, change: selector }),
        toolMessage("read-staged", "read", { path: fileName, views: ["changes"] }),
        toolMessage("unstage-change", "unstage", { file: fileName, change: selector }),
        toolMessage("read-unstaged", "read", { path: fileName, views: ["changes"] }),
        toolMessage("stage-again", "stage", { file: fileName, change: selector }),
        toolMessage("undo-staged", "undo", { file: fileName, change: selector }),
        assistantMessage([text("The Git change cycle finished")]),
      ],
    }).run("Exercise the selected Git change through the index and then undo it");

    for (const callId of [
      "stage-change",
      "read-staged",
      "unstage-change",
      "read-unstaged",
      "stage-again",
      "undo-staged",
    ]) {
      expect(getToolExecution(result, callId).isError, callId).toBe(false);
    }

    expect(getToolResultText(result, "read-staged")).toContain(`${selector} · staged`);
    expect(getToolResultText(result, "read-unstaged")).toContain(`${selector} · unstaged`);
    await expect(readFile(file, "utf8")).resolves.toBe(baseline);
    await expect(readIndexFile(directory)).resolves.toBe(baseline);
  });
}, 120_000);

test("keeps worktree content when unstage succeeds, repeats or rejects a request", async () => {
  await withTempWorkspace(async (directory) => {
    const file = path.join(directory, fileName);
    await initializeRepository(directory, file);
    await runGit(directory, ["add", fileName]);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "unstage-request-contract",
      cwd: directory,
      extensions: [...extensions.paths, changesExtension],
      tools: ["unstage", "read"],
      rawMode: false,
      conversation: [
        toolMessage("unstage-current", "unstage", { file: fileName, change: selector }),
        toolMessage("repeat-unstage", "unstage", { file: fileName, change: selector }),
        toolMessage("malformed-anchor", "unstage", { file: fileName, change: "not-an-anchor" }),
        toolMessage("missing-file", "unstage", { change: selector }),
        toolMessage("missing-change", "unstage", { file: fileName }),
        toolMessage("extra-field", "unstage", { file: fileName, change: selector, all: true }),
        toolMessage("stale-anchor", "unstage", { file: fileName, change: "CHANGE#DEADBEEF" }),
        toolMessage("read-current", "read", { path: fileName, views: ["changes"] }),
        assistantMessage([text("The Unstage requests finished")]),
      ],
    }).run("Unstage one change, repeat it and reject invalid requests without changing the file");

    expect(getToolExecution(result, "unstage-current").isError).toBe(false);
    expect(getToolExecution(result, "repeat-unstage").isError).toBe(false);
    for (const id of [
      "malformed-anchor",
      "missing-file",
      "missing-change",
      "extra-field",
      "stale-anchor",
    ]) {
      expect(getToolExecution(result, id).isError, id).toBe(true);
    }
    expect(getToolResultText(result, "read-current")).toContain(`${selector} · unstaged`);
    await expect(readFile(file, "utf8")).resolves.toBe(current);
    await expect(readIndexFile(directory)).resolves.toBe(baseline);
  });
}, 120_000);

function toolMessage(id: string, name: string, arguments_: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: arguments_ })], {
    stopReason: "toolUse",
  });
}

async function initializeRepository(directory: string, file: string): Promise<void> {
  await runGit(directory, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(file, baseline, "utf8");
  await runGit(directory, ["add", fileName]);
  await runGit(directory, [
    "-c",
    "user.name=Pi Integration",
    "-c",
    "user.email=pi-integration@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "baseline",
  ]);
  await writeFile(file, current, "utf8");
}

async function readIndexFile(directory: string): Promise<string> {
  return (await runGit(directory, ["show", `:${fileName}`])).stdout;
}

function runGit(directory: string, arguments_: readonly string[]) {
  return runFile("git", arguments_, { cwd: directory });
}
