import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getProviderSystemPrompt,
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

test.each(["on", "only"] as const)(
  "local aliases stay callable without duplicate declarations in Codemode %s mode",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "OLD\n");
      await mkdir(path.join(cwd, ".pi"), { recursive: true });
      await writeFile(path.join(cwd, ".pi/settings.json"), JSON.stringify({ codemode: { mode } }));
      const run = await new PiIntegrationTest({
        testName: `ide-alias-single-loadout-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        timeoutMs: 90_000,
        extensions: [...extensions, "builtin:codemode"],
        tools: ["read", "replace", "codemode", "mcp__fixture__read", "mcp__fixture__replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "direct-alias",
                name: "mcp__fixture__replace",
                arguments: { path: "note.txt", start: "OLD", text: "NEW" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "nested-alias",
                name: "codemode",
                arguments: {
                  code: 'text(await tools.mcp__fixture__read({path:"docs:editing"})); text(await tools.mcp__fixture__read({path:"note.txt"}));',
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Use the local aliases directly and from Codemode, including their editing guide");
      const messages = run.providerRequests[0]?.messages as Message[];
      const declared = getCurrentTools(messages);
      expect(getProviderSystemPrompt(run)).not.toContain("mcp__fixture__");
      expect(
        declared.some((tool) =>
          ["mcp__fixture__read", "mcp__fixture__replace"].includes(tool.name),
        ),
      ).toBe(false);
      expect(declared.find((tool) => tool.name === "codemode")?.description).not.toContain(
        "mcp__fixture__read",
      );
      expect(declared.find((tool) => tool.name === "codemode")?.description).not.toContain(
        "mcp__fixture__replace",
      );
      if (mode === "on") {
        expect(declared.filter((tool) => tool.name === "read")).toHaveLength(1);
        expect(declared.filter((tool) => tool.name === "replace")).toHaveLength(1);
        expect(getProviderSystemPrompt(run).match(/^- read:/gmu)).toHaveLength(1);
      }
      expect(getToolExecution(run, "direct-alias").isError).toBe(false);
      expect(
        getToolExecution(run, "nested-alias").isError,
        getToolResultText(run, "nested-alias"),
      ).toBe(false);
      expect(getToolResultText(run, "nested-alias")).toContain("# Precise text editing");
      expect(getToolResultText(run, "nested-alias")).toContain("NEW");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("NEW\n");
      expect(run.tuiRenderedOutput).not.toContain("GENERIC_ALIAS_");
    });
  },
);

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
    const declared = getCurrentTools(run.providerRequests[0]?.messages as Message[]);
    expect(declared.some((tool) => tool.name === "mcp__foreign__read")).toBe(true);
    expect(declared.some((tool) => tool.name === "read")).toBe(true);
    expect(run.tuiRenderedOutput).toContain("FOREIGN_MCP_CALL");
    expect(run.tuiRenderedOutput).toContain("FOREIGN_MCP_RESULT");
  });
});
