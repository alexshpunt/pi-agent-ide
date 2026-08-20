import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  getToolCallNames,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const base = createExtensionSet();
const registration = path.join(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/register-extension.ts",
);
const extensions = base.paths
  .filter((candidate) => !candidate.endsWith("pi-agent-text-editor/register-extension.ts"))
  .concat(registration);
afterAll(() => base.dispose());

function call(name: string, id: string, arguments_: Record<string, unknown>) {
  return toolCall({ id, name, arguments: arguments_ });
}

function batchId(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || !("agenticIdeBatch" in details)) {
    return undefined;
  }

  const batch = details.agenticIdeBatch;
  return typeof batch === "object" &&
    batch !== null &&
    "batchId" in batch &&
    typeof batch.batchId === "string"
    ? batch.batchId
    : undefined;
}

async function runImmediateAbort(
  directory: string,
  testName: string,
  tool: "write" | "replace" | "copy" | "move",
  arguments_: Record<string, unknown>,
  resourceCount: number,
) {
  const blockedId = `${testName}-blocked`;
  const skippedId = `${testName}-skipped`;
  const result = await new PiIntegrationTest({
    artifactsDir: testArtifactsDir(expect.getState().testPath),
    testName,
    cwd: directory,
    extensions,
    tools: [tool],
    conversation: [
      assistantMessage([call(tool, blockedId, arguments_), call(tool, skippedId, arguments_)], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("done")]),
    ],
  }).run(`Stop after the first ${tool} overwrite`);

  for (const phase of ["preflight", "postflight"]) {
    for (let index = 0; index < resourceCount; index += 1) {
      expect(getToolExecution(result, `${testName}-read-${phase}-${index}`)).toBeDefined();
    }
  }

  expect(getToolResultText(result, blockedId)).toContain("Reason: The file already exists");
  expect(getToolCallNames(result).filter((name) => name === tool)).toEqual([tool]);

  return result;
}

describe("pi-agent-text-editor overwrite batch recovery", () => {
  test("stops before a repeated write overwrite", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "write.txt", "before\n");

      await runImmediateAbort(
        directory,
        "overwrite-write-abort",
        "write",
        {
          path: "write.txt",
          content: "after\n",
        },
        1,
      );

      await expect(readFile(file, "utf8")).resolves.toBe("before\n");
    });
  });

  test("stops before a repeated full-file replace", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "replace.txt", "first\nmiddle\nlast\n");

      await runImmediateAbort(
        directory,
        "overwrite-replace-abort",
        "replace",
        {
          path: "replace.txt",
          start: formatLineHashAnchor(1, "first"),
          end: formatLineHashAnchor(3, "last"),
          text: "replacement",
        },
        1,
      );

      await expect(readFile(file, "utf8")).resolves.toBe("first\nmiddle\nlast\n");
    });
  });

  test("stops before a repeated copy into a full target range", async () => {
    await withTempWorkspace(async (directory) => {
      const source = await createFixture(directory, "copy-source.txt", "copy-me\nkeep\n");
      const target = await createFixture(
        directory,
        "copy-target.txt",
        "target-first\ntarget-last\n",
      );

      await runImmediateAbort(
        directory,
        "overwrite-copy-abort",
        "copy",
        {
          path: "copy-source.txt",
          start: formatLineHashAnchor(1, "copy-me"),
          target: "copy-target.txt",
          targetStart: formatLineHashAnchor(1, "target-first"),
          targetEnd: formatLineHashAnchor(2, "target-last"),
        },
        2,
      );

      await expect(readFile(source, "utf8")).resolves.toBe("copy-me\nkeep\n");
      await expect(readFile(target, "utf8")).resolves.toBe("target-first\ntarget-last\n");
    });
  });

  test("stops before a repeated move and leaves both files untouched", async () => {
    await withTempWorkspace(async (directory) => {
      const source = await createFixture(directory, "move-source.txt", "move-me\nkeep\n");
      const target = await createFixture(
        directory,
        "move-target.txt",
        "target-first\ntarget-last\n",
      );

      await runImmediateAbort(
        directory,
        "overwrite-move-abort",
        "move",
        {
          path: "move-source.txt",
          start: formatLineHashAnchor(1, "move-me"),
          target: "move-target.txt",
          targetStart: formatLineHashAnchor(1, "target-first"),
          targetEnd: formatLineHashAnchor(2, "target-last"),
        },
        2,
      );

      await expect(readFile(source, "utf8")).resolves.toBe("move-me\nkeep\n");
      await expect(readFile(target, "utf8")).resolves.toBe("target-first\ntarget-last\n");
    });
  });

  test("keeps successful same-file replacements when a later overwrite is blocked", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, "same-file.txt", "alpha\nfirst\nsecond\nomega\n");
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "overwrite-same-file-preserves-earlier-edits",
        cwd: directory,
        extensions,
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              call("replace", "same-first", {
                path: "same-file.txt",
                start: formatLineHashAnchor(2, "first"),
                text: "first-change",
              }),
              call("replace", "same-second", {
                path: "same-file.txt",
                start: formatLineHashAnchor(3, "second"),
                text: "second-change",
              }),
              call("replace", "same-overwrite", {
                path: "same-file.txt",
                start: formatLineHashAnchor(1, "alpha"),
                end: formatLineHashAnchor(4, "omega"),
                text: "must-not-apply",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Keep precise edits when the later overwrite is blocked");

      expect(getToolExecution(result, "same-first").isError).toBe(false);
      expect(getToolExecution(result, "same-second").isError).toBe(false);
      expect(getToolResultText(result, "same-overwrite")).toContain(
        "Reason: The file already exists",
      );
      expect(batchId(getToolExecutionDetails(getToolExecution(result, "same-second")))).toBe(
        batchId(getToolExecutionDetails(getToolExecution(result, "same-first"))),
      );
      await expect(readFile(file, "utf8")).resolves.toBe(
        "alpha\nfirst-change\nsecond-change\nomega\n",
      );
    });
  });

  test("keeps successful replacements on other files when an overwrite is blocked", async () => {
    await withTempWorkspace(async (directory) => {
      const first = await createFixture(directory, "earlier-first.txt", "alpha\nchange\n");
      const second = await createFixture(directory, "earlier-second.txt", "beta\nchange\n");
      const blocked = await createFixture(directory, "blocked.txt", "first\nlast\n");
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "overwrite-different-files-preserves-earlier-edits",
        cwd: directory,
        extensions,
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              call("replace", "different-first", {
                path: "earlier-first.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "first-change",
              }),
              call("replace", "different-second", {
                path: "earlier-second.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "second-change",
              }),
              call("replace", "different-overwrite", {
                path: "blocked.txt",
                start: formatLineHashAnchor(1, "first"),
                end: formatLineHashAnchor(2, "last"),
                text: "must-not-apply",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Keep earlier files when the later overwrite is blocked");

      expect(getToolExecution(result, "different-first").isError).toBe(false);
      expect(getToolExecution(result, "different-second").isError).toBe(false);
      expect(getToolResultText(result, "different-overwrite")).toContain(
        "Reason: The file already exists",
      );
      await expect(readFile(first, "utf8")).resolves.toBe("alpha\nfirst-change\n");
      await expect(readFile(second, "utf8")).resolves.toBe("beta\nsecond-change\n");
      await expect(readFile(blocked, "utf8")).resolves.toBe("first\nlast\n");
    });
  });

  test("keeps same-file replacements before an overwrite and skips later calls", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(
        directory,
        "same-file-recovery.txt",
        "alpha\nfirst\nsecond\nthird\nfourth\nomega\n",
      );
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "overwrite-same-file-aborts-later-calls",
        cwd: directory,
        extensions,
        tools: ["replace"],
        conversation: [
          assistantMessage(
            [
              call("replace", "recovery-before-first", {
                path: "same-file-recovery.txt",
                start: formatLineHashAnchor(2, "first"),
                text: "first-change",
              }),
              call("replace", "recovery-before-second", {
                path: "same-file-recovery.txt",
                start: formatLineHashAnchor(3, "second"),
                text: "second-change",
              }),
              call("replace", "recovery-overwrite", {
                path: "same-file-recovery.txt",
                start: formatLineHashAnchor(1, "alpha"),
                end: formatLineHashAnchor(6, "omega"),
                text: "must-not-apply",
              }),
              call("replace", "recovery-after-first", {
                path: "same-file-recovery.txt",
                start: formatLineHashAnchor(4, "third"),
                text: "third-change",
              }),
              call("replace", "recovery-after-second", {
                path: "same-file-recovery.txt",
                start: formatLineHashAnchor(5, "fourth"),
                text: "fourth-change",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Keep precise edits before the overwrite and abort later calls");

      expect(getToolExecution(result, "recovery-before-first").isError).toBe(false);
      expect(getToolExecution(result, "recovery-before-second").isError).toBe(false);
      expect(getToolResultText(result, "recovery-overwrite")).toContain(
        "Reason: The file already exists",
      );
      expect(getToolCallNames(result).filter((name) => name === "replace")).toEqual([
        "replace",
        "replace",
        "replace",
      ]);
      await expect(readFile(file, "utf8")).resolves.toBe(
        "alpha\nfirst-change\nsecond-change\nthird\nfourth\nomega\n",
      );
    });
  });
});
