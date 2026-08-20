import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import {
  assistantMessage,
  type AssistantMessageScenario,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const runFile = promisify(execFile);
const extensions = createExtensionSet();
const overwriteExtension = path.resolve(
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.ts",
);
const undoExtension = path.resolve("src/plugins/pi-agent-ide-changes/index.ts");
const outsideWriteExtension = path.resolve(
  "tests/integration/plugins/pi-agent-ide-changes/last-transaction/support/register-outside-write.ts",
);
const runtimeExtensions = [
  ...extensions.paths,
  overwriteExtension,
  undoExtension,
  outsideWriteExtension,
];

const done = assistantMessage([text("The last transaction undo scenario finished")]);

afterAll(() => extensions.dispose());

describe("undo last text transaction", () => {
  test("restores one direct edit and does not expose redo", async () => {
    await withTempWorkspace(async (directory) => {
      const fileName = "direct.txt";
      const initial = "alpha\nbeta";
      const file = await createFixture(directory, fileName, initial);
      const result = await runScenario(
        directory,
        "undo-last-direct",
        [
          toolMessage(
            toolCall({
              id: "direct-edit",
              name: "insert",
              arguments: { path: fileName, anchor: "end", text: "gamma" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "direct-undo",
              name: "undo",
              arguments: { file: fileName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "direct-redo-attempt",
              name: "undo",
              arguments: { file: fileName, change: "last" },
            }),
          ),
          done,
        ],
        ["insert", "undo"],
      );

      expect(getToolExecution(result, "direct-edit").isError).toBe(false);
      expect(getToolExecution(result, "direct-undo").isError).toBe(false);
      expect(getToolExecution(result, "direct-redo-attempt").isError).toBe(true);
      expect(getToolResultText(result, "direct-redo-attempt")).toContain(
        "No last text transaction",
      );
      await expect(readFile(file, "utf8")).resolves.toBe(initial);
    });
  }, 120_000);

  test("uses one snapshot for a batch and keeps files independent", async () => {
    await withTempWorkspace(async (directory) => {
      const firstName = "first.txt";
      const secondName = "second.txt";
      const firstInitial = "a1\nunchanged\na2";
      const secondInitial = "b1\nb2";
      const first = await createFixture(directory, firstName, firstInitial);
      const second = await createFixture(directory, secondName, secondInitial);
      const result = await runScenario(
        directory,
        "undo-last-batches",
        [
          toolMessage(
            toolCall({
              id: "same-batch-first",
              name: "replace",
              arguments: { path: firstName, start: "begin", text: "A1" },
            }),
            toolCall({
              id: "same-batch-second",
              name: "replace",
              arguments: { start: "end", text: "A2" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "same-batch-undo",
              name: "undo",
              arguments: { file: firstName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "multi-batch-first",
              name: "insert",
              arguments: { path: firstName, anchor: "end", text: "first batch change" },
            }),
            toolCall({
              id: "multi-batch-second",
              name: "insert",
              arguments: { path: secondName, anchor: "end", text: "second batch change" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "multi-undo-first",
              name: "undo",
              arguments: { file: firstName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({ id: "multi-read-first", name: "read", arguments: { path: firstName } }),
            toolCall({ id: "multi-read-second", name: "read", arguments: { path: secondName } }),
          ),
          toolMessage(
            toolCall({
              id: "multi-undo-second",
              name: "undo",
              arguments: { file: secondName, change: "last" },
            }),
          ),
          done,
        ],
        ["replace", "insert", "undo", "read"],
      );

      for (const id of [
        "same-batch-first",
        "same-batch-second",
        "same-batch-undo",
        "multi-batch-first",
        "multi-batch-second",
        "multi-undo-first",
        "multi-undo-second",
      ]) {
        expect(getToolExecution(result, id).isError, id).toBe(false);
      }

      expect(getToolResultText(result, "multi-read-first")).not.toContain("first batch change");
      expect(getToolResultText(result, "multi-read-second")).toContain("second batch change");
      await expect(readFile(first, "utf8")).resolves.toBe(firstInitial);
      await expect(readFile(second, "utf8")).resolves.toBe(secondInitial);
    });
  }, 120_000);

  test("keeps only the newest edit and rejects stale or new files", async () => {
    await withTempWorkspace(async (directory) => {
      const latestName = "latest.txt";
      const staleName = "stale.txt";
      const createdName = "created.txt";
      const latest = await createFixture(directory, latestName, "base");
      const stale = await createFixture(directory, staleName, "before");
      const result = await runScenario(
        directory,
        "undo-last-guards",
        [
          toolMessage(
            toolCall({
              id: "latest-first",
              name: "insert",
              arguments: { path: latestName, anchor: "end", text: "first" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "latest-second",
              name: "insert",
              arguments: { path: latestName, anchor: "end", text: "second" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "latest-undo",
              name: "undo",
              arguments: { file: latestName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "latest-older-attempt",
              name: "undo",
              arguments: { file: latestName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "stale-edit",
              name: "insert",
              arguments: { path: staleName, anchor: "end", text: "editor change" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "stale-outside-write",
              name: "outside_write",
              arguments: { path: staleName, content: "external" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "stale-undo-attempt",
              name: "undo",
              arguments: { file: staleName, change: "last" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "created-write",
              name: "write",
              arguments: { path: createdName, content: "created" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "created-undo-attempt",
              name: "undo",
              arguments: { file: createdName, change: "last" },
            }),
          ),
          done,
        ],
        ["insert", "write", "undo", "outside_write"],
      );

      expect(getToolExecution(result, "latest-undo").isError).toBe(false);
      expect(getToolExecution(result, "latest-older-attempt").isError).toBe(true);
      expect(getToolResultText(result, "latest-older-attempt")).toContain(
        "No last text transaction",
      );
      expect(getToolExecution(result, "stale-undo-attempt").isError).toBe(true);
      expect(getToolResultText(result, "stale-undo-attempt")).toContain(
        "changed after its last text transaction",
      );
      expect(getToolExecution(result, "created-write").isError).toBe(false);
      expect(getToolExecution(result, "created-undo-attempt").isError).toBe(true);
      expect(getToolResultText(result, "created-undo-attempt")).toContain(
        "No last text transaction",
      );
      await expect(readFile(latest, "utf8")).resolves.toBe("base\nfirst");
      await expect(readFile(stale, "utf8")).resolves.toBe("external");
      await expect(readFile(path.join(directory, createdName), "utf8")).resolves.toBe("created");
    });
  }, 120_000);

  test("selective undo clears the saved transaction", async () => {
    await withTempWorkspace(async (directory) => {
      const fileName = "tracked.txt";
      const baseline = "alpha\nbeta";
      const edited = `${baseline}\ngamma`;
      const file = await createFixture(directory, fileName, baseline);
      await initializeRepository(directory, fileName);
      const selector = createChangeGroups(fileName, baseline, baseline, edited)[0].selector;

      const result = await runScenario(
        directory,
        "undo-last-after-selective",
        [
          toolMessage(
            toolCall({
              id: "selective-source-edit",
              name: "insert",
              arguments: { path: fileName, anchor: "end", text: "gamma" },
            }),
          ),
          toolMessage(
            toolCall({
              id: "selective-undo",
              name: "undo",
              arguments: { file: fileName, change: selector },
            }),
          ),
          toolMessage(
            toolCall({
              id: "selective-last-attempt",
              name: "undo",
              arguments: { file: fileName, change: "last" },
            }),
          ),
          done,
        ],
        ["insert", "undo"],
      );

      expect(getToolExecution(result, "selective-source-edit").isError).toBe(false);
      expect(getToolExecution(result, "selective-undo").isError).toBe(false);
      expect(getToolExecution(result, "selective-last-attempt").isError).toBe(true);
      expect(getToolResultText(result, "selective-last-attempt")).toContain(
        "No last text transaction",
      );
      await expect(readFile(file, "utf8")).resolves.toBe(baseline);
    });
  }, 120_000);
});

function toolMessage(...calls: ReturnType<typeof toolCall>[]): AssistantMessageScenario {
  return assistantMessage(calls, { stopReason: "toolUse" });
}

async function runScenario(
  directory: string,
  testName: string,
  conversation: readonly AssistantMessageScenario[],
  tools: readonly string[],
) {
  return new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName,
    cwd: directory,
    extensions: runtimeExtensions,
    tools,
    rawMode: false,
    timeoutMs: 120_000,
    conversation,
  }).run("Restore the requested last text transaction");
}

async function initializeRepository(directory: string, fileName: string): Promise<void> {
  await runFile("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory });
  await runFile("git", ["add", fileName], { cwd: directory });
  await runFile(
    "git",
    [
      "-c",
      "user.name=Pi Integration",
      "-c",
      "user.email=pi-integration@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ],
    { cwd: directory },
  );
}
