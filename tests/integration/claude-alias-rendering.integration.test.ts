import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expect, test } from "vitest";

const extensions = [
  path.resolve("src/pi-agent-ide.ts"),
  path.resolve("tests/integration/fixtures/ide-alias-tools.ts"),
];

test("local MCP aliases keep native IDE rendering without duplicate child panels", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "ALIAS_BODY_MARKER\n");
    const run = await new PiIntegrationTest({
      testName: "ide-alias-native-rendering",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions,
      tools: ["read", "search", "mcp__fixture__read", "mcp__fixture__search"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "alias-read",
              name: "mcp__fixture__read",
              arguments: { path: "note.txt" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "alias-search",
              name: "mcp__fixture__search",
              arguments: { path: "note.txt", query: "ALIAS_BODY_MARKER" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read and search the fixture through its local MCP aliases");
    expect(getToolExecution(run, "alias-read").isError).toBe(false);
    expect(getToolResultText(run, "alias-read")).toContain("ALIAS_BODY_MARKER");
    expect(getToolResultText(run, "alias-search")).toContain("SEARCH#");
    expect(run.tuiRenderedOutput).not.toContain("GENERIC_ALIAS_");
    expect(run.tuiRenderedOutput).toContain("note.txt");
    expect(run.tuiRenderedOutput).toContain("ALIAS_BODY_MARKER");
    const savedDisplays = run.messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "custom" &&
        "customType" in message &&
        message.customType === "ide-nested-results",
    );
    expect(savedDisplays).toHaveLength(0);
  });
});

test("a local MCP mutation preserves the native diff and its file effect", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "keep\nOLD\nlast\n");
    const run = await new PiIntegrationTest({
      testName: "ide-alias-native-mutation",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions,
      tools: ["replace", "mcp__fixture__replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "alias-replace",
              name: "mcp__fixture__replace",
              arguments: { path: "note.txt", start: "OLD", text: "NEW" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace OLD through the local MCP alias");
    expect(getToolExecution(run, "alias-replace").isError).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
    expect(run.tuiRenderedOutput).not.toContain("GENERIC_ALIAS_");
    expect(run.tuiRenderedOutput).toContain("OLD");
    expect(run.tuiRenderedOutput).toContain("NEW");
  });
});
test("Codemode keeps a semantic receipt when IDE loads before the local alias owner", async () => {
  await withTempWorkspace(async (cwd) => {
    const code =
      'const receipts = []; for (const effect of ["applied","not-applied","unknown"]) receipts.push(await tools.mcp__fixture__write({path:"fixture:alias-action/"+effect,content:"probe"})); text({kinds:receipts.map(receipt=>typeof receipt),effects:receipts.map(receipt=>receipt.effect)});';
    const run = await new PiIntegrationTest({
      testName: "ide-alias-semantic-receipt",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions: [
        ...extensions,
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/alias-semantic-action.ts"),
      ],
      tools: ["write", "codemode", "mcp__fixture__write"],
      conversation: [
        assistantMessage([toolCall({ id: "receipt", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Return the semantic provider receipt through the local MCP alias");
    expect(getToolExecution(run, "receipt").isError, getToolResultText(run, "receipt")).toBe(false);
    expect(getToolResultText(run, "receipt")).toContain('"kinds":["object","object","object"]');
    expect(getToolResultText(run, "receipt")).toContain(
      '"effects":["applied","not-applied","unknown"]',
    );
    expect(await readFile(path.join(cwd, "actions.txt"), "utf8")).toBe(
      "applied\nnot-applied\nunknown\n",
    );
  });
});
test("an unrelated MCP server keeps its own renderer even with identical read metadata", async () => {
  await withTempWorkspace(async (cwd) => {
    const run = await new PiIntegrationTest({
      testName: "ide-alias-foreign-renderer",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 90_000,
      extensions,
      tools: ["read", "mcp__foreign__read"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "foreign", name: "mcp__foreign__read", arguments: { path: "unused" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Call the unrelated MCP fixture");
    expect(getToolExecution(run, "foreign").isError).toBe(false);
    expect(getToolResultText(run, "foreign")).toContain("FOREIGN_RESULT");
    expect(run.tuiRenderedOutput).toContain("FOREIGN_MCP_CALL");
    expect(run.tuiRenderedOutput).toContain("FOREIGN_MCP_RESULT");
  });
});
