import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
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

const selector = createChangeGroups(fileName, baseline, baseline, current)[0].selector;

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
        toolMessage("read-staged", "read", { path: fileName }),
        toolMessage("unstage-change", "unstage", { file: fileName, change: selector }),
        toolMessage("read-unstaged", "read", { path: fileName }),
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

function toolMessage(id: string, name: string, arguments_: Record<string, string>) {
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
