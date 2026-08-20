import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { getTextToolMutationData } from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();
const sourceFile = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/src/tools/interactive-demos/fixtures/stack-store.ts",
);
const defaultTextEditorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
);
const demoFileName = "stack-store-range-replace-demo.ts";
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 512 }, delayMs: 0 };

const replacement = [
  "    /** Undo the newest entries globally or for one file. */",
  "    async undo(steps: number, filepath?: string): Promise<UndoResult>",
  "    {",
  "        if (!Number.isSafeInteger(steps) || steps < 0)",
  "        {",
  '            return { kind: "error", text: `undo: steps must be a non-negative integer, received ${steps}` };',
  "        }",
  "",
  "        if (steps === 0)",
  "        {",
  '            return { kind: "noop", text: "undo: nothing to do (steps=0)" };',
  "        }",
  "",
  "        const projection = this.#projection(filepath);",
  "",
  "        if (steps > projection.length)",
  "        {",
  '            const scope = filepath === undefined ? "stack" : `stack for ${filepath}`;',
  "            return {",
  '                kind: "error",',
  "                text: `undo: ${scope} has ${projection.length} entries, requested ${steps}`,",
  "            };",
  "        }",
  "",
  "        const selected = projection.slice(0, steps);",
  "",
  "        if (steps === 1)",
  "        {",
  "            this.#pendingPreview = null;",
  "            return await this.#execute(selected);",
  "        }",
  "",
  "        const sequences = selected.map((entry) => entry.sequence);",
  "        const preview = this.#pendingPreview;",
  "        const matchesPreview = preview !== null",
  "            && preview.steps === steps",
  "            && preview.filepath === filepath",
  "            && preview.sequences.length === sequences.length",
  "            && preview.sequences.every((sequence, index) => sequence === sequences[index]);",
  "        const alreadyAcknowledged = preview === null",
  "            && sequences.every((sequence) => this.#acknowledgedSequences.has(sequence));",
  "",
  "        if (matchesPreview || alreadyAcknowledged)",
  "        {",
  "            this.#pendingPreview = null;",
  "            return await this.#execute(selected);",
  "        }",
  "",
  "        this.#pendingPreview = { filepath, steps, sequences };",
  "",
  "        for (const sequence of sequences)",
  "        {",
  "            this.#acknowledgedSequences.add(sequence);",
  "        }",
  "",
  "        this.#pruneAcknowledgements();",
  "        this.#save();",
  "        return this.#buildPreview(selected, sequences, filepath);",
  "    }",
].join("\n");

afterAll(() => extensions.dispose());

describe("interactive text editor demos", () => {
  test("streams a large range replacement with a moving cursor", async () => {
    await withTempWorkspace(async (directory) => {
      const initialSource = await readFile(sourceFile, "utf8");
      const lines = initialSource.split("\n");
      const demoFile = path.join(directory, demoFileName);
      expect(lines.length).toBeGreaterThanOrEqual(290);
      await writeFile(demoFile, initialSource, "utf8");

      const commentLine = requiredLine(
        lines,
        "     * Undo the newest N entries globally or in one file.",
      );
      const nextSection = requiredLine(
        lines,
        "    /** Execute undo for the exact selected entries. */",
        commentLine,
      );
      const startIndex = commentLine - 1;
      const endIndex = lines[nextSection - 1] === "" ? nextSection - 2 : nextSection - 1;
      const expectedLines = [...lines];
      expectedLines.splice(startIndex, endIndex - startIndex + 1, ...replacement.split("\n"));
      const arguments_ = {
        path: demoFileName,
        start: formatLineHashAnchor(startIndex + 1, lines[startIndex]),
        end: formatLineHashAnchor(endIndex + 1, lines[endIndex]),
        text: replacement,
      };
      const callId = "demo-large-range-replace";
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-large-range-replace",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["replace", "read"],
        rawMode: false,
        timeoutMs: 180_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: callId,
                name: "replace",
                arguments: arguments_,
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("The range replacement demo is complete", { delayMs: 0 })]),
        ],
      }).run("Replace the full undo range while showing each written line");

      const execution = getToolExecution(result, callId);
      expect(execution.isError).toBe(false);
      const mutation = getTextToolMutationData(getToolExecutionDetails(execution));
      expect(mutation.afterContent).toBe(expectedLines.join("\n"));
    });
  }, 180_000);
});

function requiredLine(lines: readonly string[], expected: string, fromIndex = 0): number {
  const index = lines.indexOf(expected, fromIndex);

  if (index === -1) {
    throw new Error(`Cannot find demo source line: ${expected}`);
  }

  return index;
}
