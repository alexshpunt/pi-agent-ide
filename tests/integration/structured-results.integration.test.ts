import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { applyOutputSchema } from "#src/extensions/pi-agent-text-editor/src/core/apply/structured-result.js";
import { diffOutputSchema } from "#src/extensions/pi-agent-text-editor/src/core/diff-tool.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("native scripts use search selectors, read lines, and explicit flush without parsing text", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\ngamma\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const code = `
const found = await tools.search({query: "beta", path: "note.txt"});
if (found.status !== "success") throw new Error("Search did not return structured success");
const match = found.data.matches[0];
const shown = await tools.read({path: match.references.line});
if (shown.status !== "success" || shown.data.lines[0].content !== "beta")
  throw new Error("Read did not return selected source data");
const accepted = await tools.replace({path: "note.txt", start: "beta", text: "BETA"});
if (accepted.status !== "success" || accepted.data.effect !== "pending")
  throw new Error("Acceptance claimed a write");
const saved = await tools.flush({});
if (saved.status !== "success" || saved.data.effect !== "applied")
  throw new Error("Flush did not report the committed write");
const after = await tools.read({path: "note.txt"});
if (!after.data.lines.some(line => line.content === "BETA"))
  throw new Error("Script continued before commit");
const empty = await tools.search({query: "__nothing__", path: "note.txt"});
if (empty.status !== "success" || empty.data.matches.length !== 0)
  throw new Error("Empty search is not a successful empty set");
text({accepted, saved});
`;
    const run = await new PiIntegrationTest({
      testName: "structured-search-read-flush",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "replace", "flush", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Search, inspect and commit edits using native structured results");
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });
});

async function runContract(cwd: string, name: string, code: string) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
  );
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [
      path.resolve("src/pi-agent-ide.ts"),
      "builtin:codemode",
      path.resolve("tests/integration/fixtures/structured-results-fixture.ts"),
    ],
    tools: ["read", "search", "replace", "receipt_edit", "flush", "codemode", "diff"],
    conversation: [
      assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Done")]),
    ],
  }).run("Verify native structured contracts");
}

test("native results keep byte and image data and reject missing or invalid adapters", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "bytes.bin"), Buffer.from([0, 255, 195, 40]));
    await writeFile(
      path.join(cwd, "long.txt"),
      Array.from({ length: 2200 }, (_, index) => `line ${index}\n`).join(""),
    );
    const run = await runContract(
      cwd,
      "structured-native-data",
      `
const bytes = await tools.read({path: "raw:bytes.bin", offset: -2, limit: 2});
if (bytes.status !== "success" || JSON.stringify(bytes.data.bytes) !== "[195,40]" || bytes.data.byteOffset !== 2) throw new Error("Raw data was altered");
const picture = await tools.read({path: "fixture-image:"});
if (picture.status !== "success" || picture.data.blocks[0].type !== "image") throw new Error("Image data was lost");
image(picture.data.blocks[0]);
const missing = await tools.read({path: "absent.txt"});
if (missing.status !== "error" || missing.errors.length === 0) throw new Error("Missing source looked empty");
for (const query of ["missing-adapter:value", "invalid-adapter:value"]) {
  const rejected = await tools.search({query});
  if (rejected.status !== "error" || rejected.data !== undefined) throw new Error("Adapter leaked arbitrary payload");
}
const long = await tools.read({path: "long.txt"});
if (long.status !== "success" || !long.data.truncated || !long.data.continuation) throw new Error("Clipping was hidden");
const next = await tools.read({...long.data.continuation, limit: 1});
if (next.data.lines[0].lineNumber !== long.data.lines.at(-1).lineNumber + 1) throw new Error("Continuation repeated or skipped data");
text({bytes: bytes.data.bytes, imageKind: picture.data.blocks[0].type, missing: missing.status, clipped: long.data.truncated});
`,
    );
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
  });
});

test("flush keeps applied effects after a post-write failure and never replays the edits", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "a.txt"), "a\n");
    await writeFile(path.join(cwd, "b.txt"), "b\n");
    const run = await runContract(
      cwd,
      "structured-partial-flush",
      `
const a = await tools.receipt_edit({path:"a.txt",text:"A\\n",fail:true});
const b = await tools.receipt_edit({path:"b.txt",text:"B\\n"});
if (a.data.effect !== "pending" || b.data.effect !== "pending" || !a.data.operationId) throw new Error("Acceptance lost its identity");
const saved = await tools.flush({});
if (saved.status !== "partial" || saved.data.effect !== "applied" || saved.errors.length === 0) throw new Error("Partial write was hidden: " + JSON.stringify(saved));
if (saved.data.operations.length !== 2 || saved.data.operations[0].id !== a.data.operationId) throw new Error("Commit lost child IDs");
if (saved.data.files.some(file => file.effect !== "applied")) throw new Error("Written files claimed rollback");
const empty = await tools.flush({});
if (empty.status !== "success" || empty.data.operations.length !== 0) throw new Error("Flush replayed old edits");
text(saved);
`,
    );
    expect(getToolExecution(run, "script").isError).toBe(true);
    expect(getToolResultText(run, "script")).toContain('"status":"partial"');
    expect(getToolResultText(run, "script")).toContain("Editor batches: 1 committed");
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B\n");
  });
});

test("Apply preserves checkpoint receipts on later failure and native data stays out of session history", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    await writeFile(path.join(cwd, "other.txt"), "beta\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    const run = await new PiIntegrationTest({
      testName: "structured-apply-checkpoint",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["apply", "diff"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "apply",
              name: "apply",
              arguments: {
                source:
                  'const file = open("note.txt"); file.replace(file.find("alpha"), "ALPHA"); flush(); throw new Error("after checkpoint");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "diff",
              name: "diff",
              arguments: { before: "note.txt", after: "other.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Verify structured Apply failure and diff");
    const applied = getToolExecutionResult(run, "apply") as {
      structuredContent: {
        status: string;
        data: { transactions: string[]; files: string[]; operations: unknown[] };
      };
    };
    expect(Value.Check(applyOutputSchema, applied.structuredContent), JSON.stringify(applied)).toBe(
      true,
    );
    expect(applied.structuredContent.status).toBe("partial");
    expect(applied.structuredContent.data.transactions).toHaveLength(1);
    expect(applied.structuredContent.data.files).toContainEqual(
      expect.stringMatching(/[/\\]note\.txt$/u),
    );
    expect(getToolExecution(run, "apply").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\n");
    const diff = getToolExecutionResult(run, "diff") as { structuredContent: unknown };
    expect(Value.Check(diffOutputSchema, diff.structuredContent), JSON.stringify(diff)).toBe(true);
    expect(getToolExecution(run, "diff").isError).toBe(false);
    expect(getToolResultMessage(run, "apply")).not.toHaveProperty("structuredContent");
  });
});
