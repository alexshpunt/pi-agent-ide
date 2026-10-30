import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";

const files = {
  "sentence.txt": "left START old words END right\n",
  "delete.txt": "left DELETE_BEGIN old words DELETE_END right\n",
  "copy-source.txt": "source prefix COPY_BEGIN body COPY_END source suffix\n",
  "copy-target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\n",
  "move-source.txt": "source prefix MOVE_BEGIN body MOVE_END source suffix\r\n",
  "move-target.txt": "target prefix TARGET_BEGIN old TARGET_END target suffix\r\n",
  "line-start.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
  "line-end.txt": "KEEP prefix START selected\nEND suffix KEEP\nlast\n",
  "credit.md": "## Leave alone\n\nKEEP THIS PARAGRAPH.\n\nBased on [source](credit).\n",
};
const expected = {
  "sentence.txt": "left NEW right\n",
  "delete.txt": "left  right\n",
  "copy-source.txt": files["copy-source.txt"],
  "copy-target.txt": "target prefix COPY_BEGIN body COPY_END target suffix\n",
  "move-source.txt": "source prefix  source suffix\r\n",
  "move-target.txt": "target prefix MOVE_BEGIN body MOVE_END target suffix\r\n",
  "line-start.txt": "NEW suffix KEEP\nlast\n",
  "line-end.txt": "KEEP prefix NEW\nlast\n",
  "credit.md": "## Leave alone\n\nKEEP THIS PARAGRAPH.\n",
};

test("range tools preserve exact endpoints and the paragraph before leading newlines", async () => {
  const root = path.resolve(".agents/tmp/exact-range-endpoints");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "case-"));
  try {
    await Promise.all(
      Object.entries(files).map(([file, content]) => writeFile(path.join(cwd, file), content)),
    );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const match = (index: number) => `SEARCH#RUNTIME:${index}:1:match`;
    const result = await new PiIntegrationTest({
      testName: "exact-range-endpoints",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve(
          "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
        ),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["read", "search", "replace", "delete", "copy", "move"],
      conversation: [
        call("sentence", "replace", {
          path: "sentence.txt",
          start: "START",
          end: "END",
          text: "NEW",
        }),
        call("delete-start", "search", { path: "delete.txt", query: "DELETE_BEGIN" }),
        call("delete-end", "search", { path: "delete.txt", query: "DELETE_END" }),
        call("delete", "delete", { path: "delete.txt", start: match(1), end: match(2) }),
        call("copy-start", "search", { path: "copy-target.txt", query: "TARGET_BEGIN" }),
        call("copy-end", "search", { path: "copy-target.txt", query: "TARGET_END" }),
        call("copy", "copy", {
          path: "copy-source.txt",
          start: "COPY_BEGIN",
          end: "COPY_END",
          target: "copy-target.txt",
          targetStart: match(3),
          targetEnd: match(4),
        }),
        call("move-start", "search", { path: "move-source.txt", query: "MOVE_BEGIN" }),
        call("move-end", "search", { path: "move-source.txt", query: "MOVE_END" }),
        call("move", "move", {
          path: "move-source.txt",
          start: match(5),
          end: match(6),
          target: "move-target.txt",
          targetStart: "TARGET_BEGIN",
          targetEnd: "TARGET_END",
        }),
        call("line-start-read", "read", {
          path: "line-start.txt",
          offset: 1,
          limit: 1,
          views: ["anchors"],
        }),
        call("line-start", "replace", {
          path: "line-start.txt",
          start: "LINE#RUNTIME:1",
          end: "END",
          text: "NEW",
        }),
        call("line-end-search", "search", { path: "line-end.txt", query: "END" }),
        call("line-end", "replace", {
          path: "line-end.txt",
          start: "START",
          end: "SEARCH#RUNTIME:7:1:line",
          text: "NEW\n",
        }),
        call("credit", "replace", {
          path: "credit.md",
          start: "\n\nBased on",
          end: "[source](credit).",
          text: "",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Change only the selected text, preserving all text outside each endpoint span.");
    for (const id of ["sentence", "delete", "copy", "move", "line-start", "line-end", "credit"])
      expect(getToolExecution(result, id).isError, id).toBe(false);
    for (const [file, content] of Object.entries(expected))
      expect(await readFile(path.join(cwd, file), "utf8"), file).toBe(content);
    const details = getToolExecutionDetails(getToolExecution(result, "credit"));
    expect(details).toHaveProperty(
      "mutationRender.0.model.rows",
      expect.arrayContaining([
        {
          kind: "context",
          text: "KEEP THIS PARAGRAPH.",
          beforeLine: 3,
          afterLine: 3,
          changed: false,
        },
      ]),
    );
    expect(result.tuiRenderedOutput).toContain("KEEP THIS PARAGRAPH.");
    expect(result.tuiRenderedOutput).toContain("credit.md");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

test("typed source merging pairs a whole-line start with an EOF line endpoint", async () => {
  const root = path.resolve(".agents/tmp/exact-range-endpoints");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "typed-"));
  try {
    await writeFile(path.join(cwd, "fixture.txt"), "KEEP\nSTART\nEND");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const result = await new PiIntegrationTest({
      testName: "typed-source-exact-range-eof",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        path.resolve(
          "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
        ),
        ...createExtensionSet().paths,
      ],
      tools: ["search", "delete"],
      conversation: [
        call("start", "search", { path: "fixture.txt", query: "START" }),
        call("end", "search", { path: "fixture.txt", query: "END" }),
        call("delete", "delete", {
          path: "SEARCH#RUNTIME:1:1:line",
          start: "START",
          end: "SEARCH#RUNTIME:2:1:line",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Delete the START line through the END line at the end of the file.");
    expect(getToolExecution(result, "delete").isError).toBe(false);
    // START matches its whole line and END is a line reference, so the pair deletes both lines.
    // The separator before START belongs to KEEP and stays outside the deleted range.
    expect(await readFile(path.join(cwd, "fixture.txt"), "utf8")).toBe("KEEP\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
