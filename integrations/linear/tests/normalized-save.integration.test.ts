import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const source = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
const wanted =
  "- [x] Finished\n\nContinue with ENG-12. [PR #162](https://github.com/example/repo/pull/162)\n\n[Evidence](https://example.org/proof)";

// Pattern: the extensions example, using real production backends and shared editor finalization.
// Contract: canonical saved content is authoritative, and unavailable readback cannot undo a save.
test.each([false, true])(
  "confirmed direct and Codemode writes retain real saved content (expanded=%s)",
  async (expanded) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/confirmed-save-"));
    try {
      await writeFile(path.join(cwd, "linear-saved.md"), "Before");
      const result = await new PiIntegrationTest({
        testName: `linear-confirmed-save-${expanded ? "expanded" : "collapsed"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 95, rows: 60 },
        environment: { LINEAR_CONFIRMED_EXPANDED: expanded ? "1" : "0" },
        extensions: [
          ide.extension,
          "builtin:codemode",
          path.join(root, "tests/fixtures/normalized-text-proof.ts"),
        ],
        tools: ["write", "read", "codemode"],
        timeoutMs: 60000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "direct",
                name: "write",
                arguments: { path: source, content: wanted },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "created",
                name: "write",
                arguments: {
                  path: "linear://example/issue/ENG-12/documents/new?title=Workpad",
                  content: "simulate-loss",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "created-body", name: "read", arguments: { path: source } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "chain",
                name: "codemode",
                arguments: {
                  code: `await tools.write({path:${JSON.stringify(source)}, content:${JSON.stringify(wanted)}});\ntext((await tools.read({path:${JSON.stringify(source)}})).text);\nawait tools.write({path:${JSON.stringify(source)},content:"simulate-loss"});\ntext((await tools.read({path:${JSON.stringify(source)}})).text);`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "unavailable",
                name: "write",
                arguments: { path: source, content: "simulate-readback" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "readback", name: "read", arguments: { path: source } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "chain-readback",
                name: "codemode",
                arguments: {
                  code: `await tools.write({path:${JSON.stringify(source)},content:"simulate-readback"});\ntext((await tools.read({path:${JSON.stringify(source)}})).text);`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([
            text("Confirmed saves were not replayed. Read the saved representation."),
          ]),
        ],
      }).run(
        "Write the Linear fixture directly and through Codemode. Keep confirmed effects separate from unavailable readback.",
      );
      await ide.record(result.artifacts.directory);
      expect(getToolExecution(result, "direct").isError, getToolResultText(result, "direct")).toBe(
        false,
      );
      expect(getToolResultText(result, "direct")).toContain("* [X] Finished");
      expect(getToolResultText(result, "direct")).toContain("<issue id=");
      expect(
        getToolExecution(result, "created").isError,
        getToolResultText(result, "created"),
      ).toBe(false);
      expect(getToolResultText(result, "created")).toContain(source);
      expect(getToolResultText(result, "created")).not.toContain("normalized");
      expect(getToolResultText(result, "created-body")).toContain("Server content");
      expect(getToolExecution(result, "chain").isError, getToolResultText(result, "chain")).toBe(
        false,
      );
      expect(getToolResultText(result, "chain")).toContain("* [X] Finished");
      expect(getToolResultText(result, "chain")).toContain("Server content");
      expect(getToolResultText(result, "chain")).not.toContain("LINEAR_SAVED_CONTENT_MISMATCH");
      expect(getToolExecution(result, "unavailable").isError).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(result, "unavailable"))).toMatchObject({
        effect: "applied",
      });
      expect(getToolResultText(result, "unavailable")).not.toContain("Write outcome unknown");
      expect(getToolResultText(result, "readback")).toContain("Saved despite unavailable readback");
      expect(getToolExecution(result, "chain-readback").isError).toBe(false);
      expect(getToolResultText(result, "chain-readback")).toContain("LINEAR_READBACK_UNAVAILABLE");
      expect(getToolResultText(result, "chain-readback")).toContain(
        "Saved despite unavailable readback",
      );
      const shown = result.tuiRenderedOutput.replaceAll(/\s+/gu, " ");
      expect(shown).toContain("Saved · follow-up unavailable");
      expect(shown).toContain("Could not read the saved resource");
      expect(result.terminalOutput).not.toContain("private transport output");
      expect(result.terminalOutput).not.toContain("\x1b[3J");
      expect(await readFile(path.join(cwd, "linear-writes.log"), "utf8")).toBe(
        "update\ncreate\nupdate\nupdate\nupdate\nupdate\n",
      );
      expect(await readFile(path.join(cwd, "linear-saved.md"), "utf8")).toBe(
        "Saved despite unavailable readback",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);
