import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import { requiredValue } from "pi-agent-invariant";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
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

test("reports an already staged change without writing the index", async () => {
  await withTempWorkspace(async (directory) => {
    const file = path.join(directory, fileName);
    await initializeRepository(directory, file);
    await runGit(directory, ["add", fileName]);
    const indexBefore = await readFile(path.join(directory, ".git", "index"));
    const lockFile = path.join(directory, ".git", "index.lock");
    const lockContent = "No index write is allowed for an already staged change.\n";
    await writeFile(lockFile, lockContent, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "stage-already-staged",
      cwd: directory,
      extensions: [...extensions.paths, changesExtension],
      tools: ["stage", "read"],
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        toolMessage("stage-unchanged", "stage", { file: fileName, change: selector }),
        assistantMessage([text("The change was already staged")]),
      ],
    }).run("Stage the current change when it is already in the index");

    const execution = getToolExecution(result, "stage-unchanged");
    expect(execution.isError).toBe(false);
    expect(getToolExecutionDetails(execution)).toMatchObject({
      action: "stage",
      change: selector,
      state: "staged",
      unchanged: true,
    });
    expect(getToolResultText(result, "stage-unchanged")).toContain(
      `${selector} is already staged in ${fileName}.`,
    );
    await expect(readFile(path.join(directory, ".git", "index"))).resolves.toEqual(indexBefore);
    await expect(readFile(lockFile, "utf8")).resolves.toBe(lockContent);
    await expect(readFile(file, "utf8")).resolves.toBe(current);
    await expect(readIndexFile(directory)).resolves.toBe(current);
  });
}, 120_000);

test("rejects a stale Stage anchor and shows how to get a current one", async () => {
  await withTempWorkspace(async (directory) => {
    const file = path.join(directory, fileName);
    await initializeRepository(directory, file);
    const updated = "alpha\nnew beta\ngamma\n";
    await writeFile(file, updated, "utf8");
    const indexBefore = await readFile(path.join(directory, ".git", "index"));
    const freshSelector = requiredValue(
      createChangeGroups(fileName, baseline, baseline, updated)[0],
    ).selector;

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "stage-stale-anchor",
      cwd: directory,
      extensions: [...extensions.paths, changesExtension],
      tools: ["stage", "read"],
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        toolMessage("stage-stale", "stage", { file: fileName, change: selector }),
        toolMessage("read-current-change", "read", { path: fileName, views: ["changes"] }),
        assistantMessage([text("A current change anchor is available after reading the file")]),
      ],
    }).run("Try the old change anchor after the worktree changes, then read the current change");

    expect(getToolExecution(result, "stage-stale").isError).toBe(true);
    expect(getToolResultText(result, "stage-stale")).toContain(
      `${selector} is not available in the current file state. Read ${fileName} with views: ["changes"] and use a current CHANGE# anchor.`,
    );
    expect(getToolExecution(result, "read-current-change").isError).toBe(false);
    expect(getToolResultText(result, "read-current-change")).toContain(freshSelector);
    expect(getToolResultText(result, "read-current-change")).not.toContain(selector);
    await expect(readFile(path.join(directory, ".git", "index"))).resolves.toEqual(indexBefore);
    await expect(readIndexFile(directory)).resolves.toBe(baseline);
    await expect(readFile(file, "utf8")).resolves.toBe(updated);
  });
}, 120_000);

test.each([
  ["clean", fileName, baseline, "the worktree text matches HEAD"],
  ["missing-from-HEAD", "new.txt", current, "the file is not present in HEAD"],
])(
  "rejects %s instead of reporting an already staged success",
  async (state, requestedFile, worktreeText, reason) => {
    await withTempWorkspace(async (directory) => {
      await initializeRepository(directory, path.join(directory, fileName));
      const file = path.join(directory, requestedFile);
      await writeFile(file, worktreeText, "utf8");
      if (state === "missing-from-HEAD") {
        // A new index entry is unsupported until the file exists in HEAD.
        await runGit(directory, ["add", requestedFile]);
      }
      const indexBefore = await readFile(path.join(directory, ".git", "index"));

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: `stage-not-applicable-${state}`,
        cwd: directory,
        extensions: [...extensions.paths, changesExtension],
        tools: ["stage", "read"],
        rawMode: false,
        timeoutMs: 120_000,
        conversation: [
          toolMessage("stage-not-applicable", "stage", { file: requestedFile, change: selector }),
          assistantMessage([text("This file has no applicable Stage change")]),
        ],
      }).run("Stage a file that has no current tracked change for this operation");

      expect(getToolExecution(result, "stage-not-applicable").isError).toBe(true);
      expect(getToolResultText(result, "stage-not-applicable")).toContain(
        `Cannot stage ${requestedFile}: ${reason}.`,
      );
      await expect(readFile(path.join(directory, ".git", "index"))).resolves.toEqual(indexBefore);
      await expect(readFile(file, "utf8")).resolves.toBe(worktreeText);
    });
  },
  120_000,
);

test.each([
  "worktree-binary",
  "git-binary",
  "outside-worktree",
  "conflicted",
  "no-worktree",
  "missing-head",
])(
  "resolves Stage and Unstage sources for %s",
  async (state) => {
    await withTempWorkspace(async (directory) => {
      await withTempWorkspace(async (outsideDirectory) => {
        let requestedFile = fileName;
        let reason: string;
        const file = path.join(directory, fileName);
        if (state === "no-worktree") {
          await runGit(directory, ["init", "--quiet", "--bare"]);
          await writeFile(file, current, "utf8");
          reason = await gitFailure(directory, ["rev-parse", "--show-toplevel"]);
        } else if (state === "missing-head") {
          await runGit(directory, ["init", "--quiet", "--initial-branch=main"]);
          await writeFile(file, current, "utf8");
          reason = await gitFailure(directory, ["rev-parse", "--verify", "HEAD"]);
        } else {
          await initializeRepository(directory, file);
          if (state === "worktree-binary") {
            await writeFile(file, "alpha\0beta\n", "utf8");
            reason = "worktree file contains binary content";
          } else if (state === "git-binary") {
            await writeFile(file, "alpha\0beta\n", "utf8");
            await runGit(directory, ["add", fileName]);
            await writeFile(file, current, "utf8");
            reason = "Git file state contains binary content";
          } else if (state === "conflicted") {
            await runGit(directory, ["config", "user.name", "Pi Integration"]);
            await runGit(directory, ["config", "user.email", "pi-integration@example.invalid"]);
            await runGit(directory, ["add", fileName]);
            await runGit(directory, ["commit", "--quiet", "-m", "main change"]);
            await runGit(directory, ["checkout", "--quiet", "-b", "other", "HEAD~1"]);
            await writeFile(file, "alpha\nother beta\ngamma\n", "utf8");
            await runGit(directory, ["add", fileName]);
            await runGit(directory, ["commit", "--quiet", "-m", "other change"]);
            await runGit(directory, ["checkout", "--quiet", "main"]);
            await gitFailure(directory, ["merge", "--no-edit", "other"]);
            reason = `${fileName} has unresolved Git index entries`;
          } else {
            requestedFile = path.join(outsideDirectory, fileName);
            await initializeRepository(outsideDirectory, requestedFile);
            reason = "";
          }
        }
        const hasIndex = state !== "no-worktree" && state !== "missing-head";
        const indexFile = path.join(directory, ".git", "index");
        const indexBefore = hasIndex ? await readFile(indexFile) : undefined;
        const worktreeBefore = await readFile(path.resolve(directory, requestedFile));

        const result = await new PiIntegrationTest({
          artifactsDir: testArtifactsDir(expect.getState().testPath),
          testName: `stage-source-${state}`,
          cwd: directory,
          extensions: [...extensions.paths, changesExtension],
          tools: ["stage", "unstage", "read"],
          rawMode: false,
          timeoutMs: 120_000,
          conversation: [
            toolMessage("stage-source-error", "stage", { file: requestedFile, change: selector }),
            ...(state === "outside-worktree"
              ? [
                  toolMessage("read-owner-staged", "read", {
                    path: requestedFile,
                    views: ["changes"],
                  }),
                ]
              : []),
            toolMessage("unstage-source-error", "unstage", {
              file: requestedFile,
              change: selector,
            }),
            assistantMessage([text("The selected Git source was inspected")]),
          ],
        }).run("Use the selected file’s Git repository and report unsupported sources");

        if (state === "outside-worktree") {
          for (const id of ["stage-source-error", "read-owner-staged", "unstage-source-error"])
            expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
          expect(getToolResultText(result, "read-owner-staged")).toContain(`${selector} · staged`);
          await expect(readIndexFile(outsideDirectory)).resolves.toBe(baseline);
          await expect(readFile(indexFile)).resolves.toEqual(indexBefore);
          await expect(readIndexFile(directory)).resolves.toBe(baseline);
          await expect(readFile(requestedFile, "utf8")).resolves.toBe(current);
          return;
        }
        expect(getToolExecution(result, "stage-source-error").isError).toBe(true);
        expect(getToolResultText(result, "stage-source-error")).toContain(
          `Cannot stage ${requestedFile}: ${reason}`,
        );
        expect(getToolExecution(result, "unstage-source-error").isError).toBe(true);
        expect(getToolResultText(result, "unstage-source-error")).toContain(reason);
        expect(getToolResultText(result, "unstage-source-error")).not.toContain("Cannot stage");
        expect(getToolResultText(result, "stage-source-error")).toContain(
          `Cannot stage ${requestedFile}: ${getToolResultText(result, "unstage-source-error")}`,
        );
        if (hasIndex) {
          await expect(readFile(indexFile)).resolves.toEqual(indexBefore);
        } else {
          await expect(readFile(indexFile)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(readFile(path.resolve(directory, requestedFile))).resolves.toEqual(
          worktreeBefore,
        );
      });
    });
  },
  120_000,
);

test.each(["stage", "unstage"] as const)(
  "reports %s index write failure without promising no effects",
  async (action) => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, fileName);
      await initializeRepository(directory, file);
      if (action === "unstage") await runGit(directory, ["add", fileName]);
      const indexFile = path.join(directory, ".git", "index");
      const indexBefore = await readFile(indexFile);
      const lockFile = path.join(directory, ".git", "index.lock");
      const lockContent = "This fixture blocks index writes.\n";
      await writeFile(lockFile, lockContent, "utf8");

      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: `${action}-index-write-failure`,
        cwd: directory,
        extensions: [...extensions.paths, changesExtension],
        tools: ["stage", "unstage", "read"],
        rawMode: false,
        timeoutMs: 120_000,
        conversation: [
          toolMessage("index-write-failure", action, { file: fileName, change: selector }),
          toolMessage("read-after-failure", "read", { path: fileName, views: ["changes"] }),
          assistantMessage([text("The failed index operation was inspected before any retry")]),
        ],
      }).run("Try an index update blocked by this fixture's lock, then inspect the changes");

      const execution = getToolExecution(result, "index-write-failure");
      expect(execution.isError).toBe(true);
      const errorText = getToolResultText(result, "index-write-failure");
      expect(errorText).toContain("index.lock");
      expect(execution.result).toMatchObject({
        structuredContent: {
          status: "error",
          data: { action, effect: "unknown" },
          errors: [{ code: "INDEX_CHANGE_FAILED" }],
        },
      });
      const recovery = `The index may have changed. Read ${fileName} with views: ["changes"] before retrying.`;
      if (action === "stage") expect(errorText).toContain(recovery);
      else expect(errorText).not.toContain(recovery);
      expect(getToolExecution(result, "read-after-failure").isError).toBe(false);
      expect(getToolResultText(result, "read-after-failure")).toContain(
        `${selector} · ${action === "stage" ? "unstaged" : "staged"}`,
      );
      await expect(readFile(indexFile)).resolves.toEqual(indexBefore);
      await expect(readFile(lockFile, "utf8")).resolves.toBe(lockContent);
      await expect(readFile(file, "utf8")).resolves.toBe(current);
    });
  },
  120_000,
);
test.each(["before", "after"])(
  "keeps Stage cancellation distinct from success %s the index write",
  async (phase) => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, fileName);
      await initializeRepository(directory, file);
      await writeFile(path.join(directory, "cancel-phase.txt"), phase, "utf8");
      const indexFile = path.join(directory, ".git", "index");
      const indexBefore = await readFile(indexFile);
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: `stage-cancel-${phase}-write`,
        cwd: directory,
        extensions: [
          ...extensions.paths,
          path.resolve(
            "tests/integration/plugins/pi-agent-ide-changes/index/cancel-stage-extension.ts",
          ),
        ],
        tools: ["stage"],
        rawMode: false,
        timeoutMs: 120_000,
        conversation: [
          toolMessage("stage-cancelled", "stage", { file: fileName, change: selector }),
        ],
      }).run("Stage the change while the fixture cancels at the index write boundary");

      const execution = getToolExecution(result, "stage-cancelled");
      expect(execution.isError).toBe(true);
      expect(getToolResultText(result, "stage-cancelled")).not.toContain(`Staged ${selector}`);
      expect(execution.result).not.toMatchObject({
        structuredContent: { status: "success" },
      });
      await expect(readFile(path.join(directory, "cancel-boundary.txt"), "utf8")).resolves.toBe(
        phase,
      );
      await expect(readFile(file, "utf8")).resolves.toBe(current);
      await expect(readIndexFile(directory)).resolves.toBe(phase === "before" ? baseline : current);
      if (phase === "before") {
        await expect(readFile(indexFile)).resolves.toEqual(indexBefore);
      } else {
        expect(await readFile(indexFile)).not.toEqual(indexBefore);
      }
    });
  },
  120_000,
);
async function gitFailure(directory: string, arguments_: readonly string[]): Promise<string> {
  try {
    await runGit(directory, arguments_);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return error.stderr.trim();
    }
    throw error;
  }
  throw new Error("Expected Git to reject the unavailable repository state");
}

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
