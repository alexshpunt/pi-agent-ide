import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";

const extensions = createExtensionSet();
const tempRoot = path.resolve(".agents/tmp/source-inheritance");

// Each mutation runs in its own assistant turn, after the standalone read has completed.
test.each([
  {
    name: "replace",
    arguments: { start: formatLineHashAnchor(1, "HEADER"), text: "CHANGED" },
    expected: "CHANGED\nBODY\nTAIL\n",
  },
  {
    name: "replace",
    arguments: { start: "HEADER", end: "BODY", text: "CHANGED" },
    expected: "CHANGED\nTAIL\n",
  },
  {
    name: "replace",
    arguments: { start: "HEADER", text: "CHANGED" },
    expected: "CHANGED\nBODY\nTAIL\n",
  },
  {
    name: "insert",
    arguments: { anchor: "HEADER", text: "ADDED" },
    expected: "HEADER\nADDED\nBODY\nTAIL\n",
  },
  { name: "delete", arguments: { start: "HEADER" }, expected: "BODY\nTAIL\n" },
  {
    name: "copy",
    arguments: { start: "HEADER", targetStart: "TAIL" },
    expected: "HEADER\nBODY\nTAIL\nHEADER\n",
  },
  {
    name: "move",
    arguments: { start: "HEADER", targetStart: "TAIL" },
    expected: "BODY\nTAIL\nHEADER\n",
  },
  {
    name: "replace",
    arguments: { start: "begin", text: "CHANGED" },
    expected: "CHANGED\nBODY\nTAIL\n",
  },
])(
  "inherits a standalone read source for $name with $arguments",
  async ({ name, arguments: args, expected }) => {
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(path.join(tempRoot, "plain-"));
    const file = path.join(cwd, "notes.txt");
    try {
      await writeFile(file, "HEADER\nBODY\nTAIL\n");
      const result = await new PiIntegrationTest({
        testName: `read-inheritance-${name}-${args.start ?? "insert"}-${args.end ?? "single"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        isolateUserResources: true,
        cwd,
        extensions: extensions.paths,
        tools: ["read", name],
        conversation: [
          assistantMessage(
            [toolCall({ id: "read", name: "read", arguments: { path: "notes.txt" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "mutate", name, arguments: args })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Done")]),
        ],
      }).run("Read notes.txt, then edit it without repeating its path.");
      expect(getToolResultText(result, "mutate")).not.toContain("path is required");
      expect(await readFile(file, "utf8")).toBe(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

// Use the base runner: automatic preflight reads would hide missing-history regressions.
test("keeps missing sources, explicit paths, invalid anchors, and batch inheritance safe", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "guards-"));
  const notes = path.join(cwd, "notes.txt");
  const other = path.join(cwd, "other.txt");
  try {
    await writeFile(notes, "HEADER\nBODY\nTAIL\n");
    await writeFile(other, "HEADER\nBODY\nTAIL\n");
    const calls = [
      { id: "no-history", name: "replace", arguments: { start: "HEADER", text: "BAD" } },
      { id: "read", name: "read", arguments: { path: "notes.txt" } },
      {
        id: "invalid-anchor",
        name: "replace",
        arguments: { start: "SEARCH#DEADBEEF:1:match", text: "BAD" },
      },
      {
        id: "empty-source",
        name: "replace",
        arguments: { path: "", start: "HEADER", text: "BAD" },
      },
      {
        id: "explicit-source",
        name: "replace",
        arguments: { path: "other.txt", start: "HEADER", text: "EXPLICIT" },
      },
      { id: "read-again", name: "read", arguments: { path: "notes.txt" } },
    ];
    const result = await new PiIntegrationTest({
      testName: "source-inheritance-guards",
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      cwd,
      extensions: extensions.paths,
      tools: ["read", "replace"],
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage(
          [
            toolCall({
              id: "batch-first",
              name: "replace",
              arguments: { path: "other.txt", start: "BODY", text: "BATCH" },
            }),
            toolCall({
              id: "batch-inherited",
              name: "replace",
              arguments: { start: "TAIL", text: "INHERITED" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Check source guards and same-block source inheritance.");
    expect(getToolResultText(result, "no-history")).toContain("path is required");
    expect(getToolResultText(result, "empty-source")).toContain("path is required");
    expect(getToolResultText(result, "invalid-anchor")).toContain("EDIT_FAILED");
    expect(await readFile(notes, "utf8")).toBe("HEADER\nBODY\nTAIL\n");
    expect(await readFile(other, "utf8")).toBe("EXPLICIT\nBATCH\nINHERITED\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps typed source and destination ownership separate from the last read", async () => {
  await mkdir(tempRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(tempRoot, "typed-"));
  const runtimeAnchors = path.resolve(
    "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
  );
  try {
    await writeFile(path.join(cwd, "first.txt"), "needle first\n");
    await writeFile(path.join(cwd, "second.txt"), "needle second\n");
    await writeFile(path.join(cwd, "notes.txt"), "HEADER\nBODY\nTAIL\n");
    const calls = [
      { id: "search", name: "search", arguments: { query: "needle" } },
      { id: "read", name: "read", arguments: { path: "notes.txt" } },
      {
        id: "typed-source",
        name: "replace",
        arguments: { start: "SEARCH#RUNTIME:1:all:match", text: "changed" },
      },
      { id: "search-target", name: "search", arguments: { query: "changed", path: "first.txt" } },
      { id: "read-source", name: "read", arguments: { path: "notes.txt" } },
      {
        id: "typed-target",
        name: "copy",
        arguments: { start: "HEADER", targetStart: "SEARCH#RUNTIME:2:1:line" },
      },
    ];
    await new PiIntegrationTest({
      testName: "source-inheritance-typed-ownership",
      artifactsDir: testArtifactsDir(import.meta.filename),
      isolateUserResources: true,
      cwd,
      extensions: [...extensions.paths, runtimeAnchors],
      tools: ["read", "search", "replace", "copy"],
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Keep search-owned targets while inheriting only the omitted primary source.");
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("HEADER\nBODY\nTAIL\n");
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("changed first\nHEADER\n");
    expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("changed second\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
