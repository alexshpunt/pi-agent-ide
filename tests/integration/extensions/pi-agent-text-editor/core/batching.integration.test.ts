import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const deferredResult = "final file result is in the last successful tool call for that file";
afterAll(() => extensions.dispose());

function call(name: string, id: string, arguments_: Record<string, unknown>) {
  return toolCall({ id, name, arguments: arguments_ });
}

describe("pi-agent-text-editor batching", () => {
  test("executes flat write calls as one batch and returns each call its file", async () => {
    await withTempWorkspace(async (directory) => {
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-write",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["write"],
        conversation: [
          assistantMessage(
            [
              call("write", "write-first", { path: "first.txt", content: "first" }),
              call("write", "write-second", { path: "second.txt", content: "second" }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Write both files");

      expect(getToolExecution(result, "write-first").isError).toBe(false);
      expect(getToolExecution(result, "write-second").isError).toBe(false);
      await expect(readFile(path.join(directory, "first.txt"), "utf8")).resolves.toBe("first");
      await expect(readFile(path.join(directory, "second.txt"), "utf8")).resolves.toBe("second");
    });
  });

  test("inherits path and returns the final file only from its last successful call", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "shared.txt");
      await writeFile(file, "alpha\nreplace-me\ndelete-me\nomega", "utf8");
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-path-inheritance",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["replace", "delete"],
        conversation: [
          assistantMessage(
            [
              call("replace", "replace-shared", {
                path: "shared.txt",
                start: formatLineHashAnchor(2, "replace-me"),
                text: "replaced",
              }),
              call("delete", "delete-shared", {
                start: formatLineHashAnchor(3, "delete-me"),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Edit the shared file");

      expect(getToolExecution(result, "replace-shared").isError).toBe(false);
      expect(getToolExecution(result, "delete-shared").isError).toBe(false);
      expect(getToolResultText(result, "replace-shared")).toContain(deferredResult);
      expect(getToolResultText(result, "replace-shared")).not.toContain("replaced");
      expect(getToolResultText(result, "delete-shared")).toContain("shared.txt");
      expect(getToolResultText(result, "delete-shared")).toContain(
        `${formatLineHashAnchor(2, "replaced")}|replaced`,
      );
      expect(getToolResultText(result, "delete-shared")).toContain(
        `${formatLineHashAnchor(3, "omega")}|omega`,
      );
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\nreplaced\nomega");
    });
  });
  test("runs all six mutation tools across three explicit file paths", async () => {
    await withTempWorkspace(async (directory) => {
      const writtenFile = path.join(directory, "written.txt");
      const editedFile = path.join(directory, "edited.txt");
      const movedFile = path.join(directory, "moved.txt");
      await writeFile(editedFile, "alpha\nreplace-me\ncopy-me\ninsert-anchor\nomega", "utf8");
      await writeFile(movedFile, "alpha\ndelete-me\nmove-me\nkeep\nomega", "utf8");
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-all-tools-three-files",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["write", "replace", "insert", "delete", "copy", "move"],
        conversation: [
          assistantMessage(
            [
              call("write", "all-write", { path: "written.txt", content: "created" }),
              call("replace", "all-replace", {
                path: "edited.txt",
                start: formatLineHashAnchor(2, "replace-me"),
                text: "replaced",
              }),
              call("delete", "all-delete", {
                path: "moved.txt",
                start: formatLineHashAnchor(2, "delete-me"),
              }),
              call("insert", "all-insert", {
                path: "edited.txt",
                anchor: formatLineHashAnchor(4, "insert-anchor"),
                text: "inserted",
              }),
              call("move", "all-move", {
                path: "moved.txt",
                start: formatLineHashAnchor(3, "move-me"),
                targetStart: formatLineHashAnchor(5, "omega"),
              }),
              call("copy", "all-copy", {
                path: "edited.txt",
                start: formatLineHashAnchor(3, "copy-me"),
                targetStart: formatLineHashAnchor(5, "omega"),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Run every text mutation tool across three files");

      for (const callId of [
        "all-write",
        "all-replace",
        "all-delete",
        "all-insert",
        "all-move",
        "all-copy",
      ]) {
        expect(getToolExecution(result, callId).isError).toBe(false);
      }

      expect(getToolResultText(result, "all-replace")).toContain(deferredResult);
      expect(getToolResultText(result, "all-delete")).toContain(deferredResult);
      expect(getToolResultText(result, "all-insert")).toContain(deferredResult);
      expect(getToolResultText(result, "all-write")).toContain("written.txt");
      expect(getToolResultText(result, "all-move")).toContain("moved.txt");
      expect(getToolResultText(result, "all-copy")).toContain("edited.txt");
      await expect(readFile(writtenFile, "utf8")).resolves.toBe("created");
      await expect(readFile(editedFile, "utf8")).resolves.toBe(
        "alpha\nreplaced\ncopy-me\ninsert-anchor\ninserted\nomega\ncopy-me",
      );
      await expect(readFile(movedFile, "utf8")).resolves.toBe("alpha\nkeep\nomega\nmove-me");
    });
  });

  test("runs three grouped calls for each of three explicit file paths", async () => {
    await withTempWorkspace(async (directory) => {
      const files = ["first-grouped.txt", "second-grouped.txt", "third-grouped.txt"] as const;
      const initial = "alpha\nchange\nanchor\ntail";
      await Promise.all(
        files.map((file) => writeFile(path.join(directory, file), initial, "utf8")),
      );
      const groupedCalls = files.flatMap((file, index) => {
        const id = String(index + 1);
        return [
          call("replace", `grouped-${id}-replace`, {
            path: file,
            start: formatLineHashAnchor(2, "change"),
            text: `changed-${id}`,
          }),
          call("insert", `grouped-${id}-insert`, {
            path: file,
            anchor: formatLineHashAnchor(3, "anchor"),
            text: `added-${id}`,
          }),
          call("copy", `grouped-${id}-copy`, {
            path: file,
            start: formatLineHashAnchor(1, "alpha"),
            targetStart: formatLineHashAnchor(4, "tail"),
          }),
        ];
      });
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-grouped-three-by-three",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["replace", "insert", "copy"],
        conversation: [
          assistantMessage(groupedCalls, { stopReason: "toolUse" }),
          assistantMessage([text("done")]),
        ],
      }).run("Run three grouped calls for each of three files");

      for (const [index, file] of files.entries()) {
        const id = String(index + 1);
        expect(getToolResultText(result, `grouped-${id}-replace`)).toContain(deferredResult);
        expect(getToolResultText(result, `grouped-${id}-insert`)).toContain(deferredResult);
        expect(getToolResultText(result, `grouped-${id}-copy`)).toContain(file);
        await expect(readFile(path.join(directory, file), "utf8")).resolves.toBe(
          `alpha\nchanged-${id}\nanchor\nadded-${id}\ntail\nalpha`,
        );
      }
    });
  });
  test("routes each interleaved file result to its last successful call", async () => {
    await withTempWorkspace(async (directory) => {
      const firstFile = path.join(directory, "first-mixed.txt");
      const secondFile = path.join(directory, "second-mixed.txt");
      const thirdFile = path.join(directory, "third-mixed.txt");
      const initial = "alpha\nchange\nanchor\ntail";
      await Promise.all([
        writeFile(firstFile, initial, "utf8"),
        writeFile(secondFile, initial, "utf8"),
        writeFile(thirdFile, initial, "utf8"),
      ]);
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-interleaved-three-files",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["replace", "insert", "delete", "copy"],
        conversation: [
          assistantMessage(
            [
              call("replace", "mixed-first-replace", {
                path: "first-mixed.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "changed-first",
              }),
              call("delete", "mixed-second-delete", {
                path: "second-mixed.txt",
                start: formatLineHashAnchor(2, "change"),
              }),
              call("replace", "mixed-third-replace", {
                path: "third-mixed.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "changed-third",
              }),
              call("insert", "mixed-first-insert", {
                path: "first-mixed.txt",
                anchor: formatLineHashAnchor(3, "anchor"),
                text: "added-first",
              }),
              call("insert", "mixed-second-insert", {
                path: "second-mixed.txt",
                anchor: formatLineHashAnchor(3, "anchor"),
                text: "added-second",
              }),
              call("delete", "mixed-third-delete", {
                path: "third-mixed.txt",
                start: formatLineHashAnchor(1, "alpha"),
              }),
              call("copy", "mixed-first-copy", {
                path: "first-mixed.txt",
                start: formatLineHashAnchor(1, "alpha"),
                targetStart: formatLineHashAnchor(4, "tail"),
              }),
              call("copy", "mixed-second-copy", {
                path: "second-mixed.txt",
                start: formatLineHashAnchor(1, "alpha"),
                targetStart: formatLineHashAnchor(4, "tail"),
              }),
              call("copy", "mixed-third-copy", {
                path: "third-mixed.txt",
                start: formatLineHashAnchor(1, "alpha"),
                targetStart: formatLineHashAnchor(4, "tail"),
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Interleave explicit edits for three files");

      for (const callId of [
        "mixed-first-replace",
        "mixed-second-delete",
        "mixed-third-replace",
        "mixed-first-insert",
        "mixed-second-insert",
        "mixed-third-delete",
      ]) {
        expect(getToolResultText(result, callId)).toContain(deferredResult);
      }

      expect(getToolResultText(result, "mixed-first-copy")).toContain("first-mixed.txt");
      expect(getToolResultText(result, "mixed-second-copy")).toContain("second-mixed.txt");
      expect(getToolResultText(result, "mixed-third-copy")).toContain("third-mixed.txt");
      await expect(readFile(firstFile, "utf8")).resolves.toBe(
        "alpha\nchanged-first\nanchor\nadded-first\ntail\nalpha",
      );
      await expect(readFile(secondFile, "utf8")).resolves.toBe(
        "alpha\nanchor\nadded-second\ntail\nalpha",
      );
      await expect(readFile(thirdFile, "utf8")).resolves.toBe("changed-third\nanchor\ntail\nalpha");
    });
  });
  test("keeps a failed call visible while routing final state to the last successful call", async () => {
    await withTempWorkspace(async (directory) => {
      const file = path.join(directory, "partial-failure.txt");
      await writeFile(file, "alpha\nchange\nanchor\nomega", "utf8");
      const result = await new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName: "text-editor-batch-partial-failure-results",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["replace", "insert"],
        conversation: [
          assistantMessage(
            [
              call("replace", "partial-first", {
                path: "partial-failure.txt",
                start: formatLineHashAnchor(2, "change"),
                text: "changed",
              }),
              call("replace", "partial-failed", {
                path: "partial-failure.txt",
                start: formatLineHashAnchor(99, "missing"),
                text: "never",
              }),
              call("insert", "partial-last", {
                path: "partial-failure.txt",
                anchor: formatLineHashAnchor(3, "anchor"),
                text: "added",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Apply the valid edits and report the invalid one");

      expect(getToolExecution(result, "partial-first").isError).toBe(false);
      expect(getToolResultText(result, "partial-first")).toContain(deferredResult);
      expect(getToolExecution(result, "partial-failed").isError).toBe(true);
      expect(getToolResultText(result, "partial-failed")).toContain("replace blocked");
      expect(getToolResultText(result, "partial-failed")).toContain("was not found");
      expect(getToolExecution(result, "partial-last").isError).toBe(false);
      expect(getToolResultText(result, "partial-last")).toContain("partial-failure.txt");
      expect(getToolResultText(result, "partial-last")).toContain("changed");
      expect(getToolResultText(result, "partial-last")).toContain("added");
      await expect(readFile(file, "utf8")).resolves.toBe("alpha\nchanged\nanchor\nadded\nomega");
    });
  });
});
