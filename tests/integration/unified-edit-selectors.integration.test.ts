import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const malformed = [
  ["delete-at-with-range", "delete", { at: "OPEN", from: "OPEN", through: "CLOSE" }],
  ["delete-without-end", "delete", { after: "OPEN" }],
  ["delete-legacy", "delete", { start: "OPEN", end: "CLOSE" }],
  [
    "copy-both-starts",
    "copy",
    { from: "OPEN", after: "OPEN", through: "CLOSE", targetAfter: "TAIL" },
  ],
  [
    "move-both-ends",
    "move",
    { from: "OPEN", before: "TAIL", through: "CLOSE", targetBefore: "TAIL" },
  ],
  [
    "copy-both-target-ends",
    "copy",
    { at: "body", targetFrom: "HEAD", targetThrough: "TAIL", targetBefore: "TAIL" },
  ],
  [
    "move-at-with-target-range",
    "move",
    { at: "body", targetAt: "HEAD", targetFrom: "HEAD", targetThrough: "TAIL" },
  ],
  ["copy-without-target-end", "copy", { at: "body", targetFrom: "HEAD" }],
  ["move-without-target-start", "move", { at: "body", targetThrough: "TAIL" }],
  ["copy-legacy-target", "copy", { at: "body", targetStart: "HEAD", targetEnd: "TAIL" }],
  ["move-legacy-source", "move", { start: "OPEN", end: "CLOSE", targetBefore: "HEAD" }],
  ["insert-both-sides", "insert", { after: "OPEN", before: "CLOSE", text: "BAD" }],
  ["insert-legacy-anchor", "insert", { anchor: "OPEN", before: true, text: "BAD" }],
  ["insert-legacy-flag", "insert", { before: false, text: "BAD" }],
] as const;

const source = "OPEN\nbody\nCLOSE\n\nTAIL\n";
const target = "HEAD\nold\nTAIL\n";
const singleTurn = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

test("editing tools reject mixed, incomplete, and legacy selectors without changing either file", async () => {
  await withTempWorkspace(async (cwd) => {
    const src = await createFixture(cwd, "source.txt", source);
    const dst = await createFixture(cwd, "target.txt", target);
    const result = await new PiIntegrationTest({
      testName: "unified-invalid-edit-selectors",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["delete", "copy", "move", "insert"],
      conversation: [
        ...malformed.map(([id, name, args]) =>
          singleTurn(id, name, {
            path: "source.txt",
            ...(name === "copy" || name === "move" ? { target: "target.txt" } : {}),
            ...args,
          }),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Check the supplied selector forms.");
    for (const [id] of malformed) expect(getToolExecution(result, id).isError, id).toBe(true);
    await expect(readFile(src, "utf8")).resolves.toBe(source);
    await expect(readFile(dst, "utf8")).resolves.toBe(target);
  });
}, 90_000);

test("whole-line editing preserves the markers and separates inserted lines", async () => {
  await withTempWorkspace(async (cwd) => {
    const deleted = await createFixture(cwd, "delete.txt", source);
    const moved = await createFixture(cwd, "move.txt", source);
    const copied = await createFixture(cwd, "copy.txt", source);
    const inserted = await createFixture(cwd, "insert.txt", source);
    const before = await createFixture(cwd, "target-before.txt", target);
    const range = await createFixture(cwd, "target-range.txt", "HEAD\nold\nolder\nTAIL\n");
    const result = await new PiIntegrationTest({
      testName: "unified-valid-edit-selectors",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["delete", "copy", "move", "insert"],
      conversation: [
        singleTurn("delete", "delete", { path: "delete.txt", from: "OPEN", through: "CLOSE" }),
        singleTurn("move", "move", {
          path: "move.txt",
          after: "OPEN",
          before: "CLOSE",
          target: "target-before.txt",
          targetBefore: "TAIL",
        }),
        singleTurn("copy", "copy", {
          path: "copy.txt",
          at: "body",
          target: "target-range.txt",
          targetAfter: "HEAD",
          targetBefore: "TAIL",
        }),
        singleTurn("insert-before", "insert", {
          path: "insert.txt",
          before: "OPEN",
          text: "top\n",
        }),
        singleTurn("insert-after", "insert", {
          path: "insert.txt",
          after: "CLOSE",
          text: "bottom\n",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Apply the supplied edits.");
    for (const id of ["delete", "move", "copy", "insert-before", "insert-after"]) {
      expect(getToolExecution(result, id).isError, id).toBe(false);
    }
    await expect(readFile(deleted, "utf8")).resolves.toBe("\nTAIL\n");
    await expect(readFile(moved, "utf8")).resolves.toBe("OPEN\nCLOSE\n\nTAIL\n");
    await expect(readFile(copied, "utf8")).resolves.toBe(source);
    await expect(readFile(inserted, "utf8")).resolves.toBe(
      "top\nOPEN\nbody\nCLOSE\nbottom\n\nTAIL\n",
    );
    await expect(readFile(before, "utf8")).resolves.toBe("HEAD\nold\nbody\nTAIL\n");
    await expect(readFile(range, "utf8")).resolves.toBe("HEAD\nbody\nTAIL\n");
  });
}, 90_000);
