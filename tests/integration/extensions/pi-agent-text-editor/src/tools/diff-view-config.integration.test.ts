import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest as BasePiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
);

// Large enough that the compact 12-row window must clip it,
// small enough that the full panel fits one terminal screen.
const SWAPPED_ROWS = 18;
const swappedLine = (index: number): string =>
  `const swappedLine${String(index).padStart(2, "0")} = "diff-view-row-${String(index).padStart(2, "0")}";`;
const replacement = Array.from({ length: SWAPPED_ROWS }, (_, index) => swappedLine(index + 1)).join(
  "\n",
);
// Stream arguments at a humanly readable rate: the diff panel animates its rows,
// and instant delivery makes the final frames land after the harness captures.
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 16 }, delayMs: 24 };

afterAll(() => extensions.dispose());

describe("text editor diff view config", () => {
  test("renders every replaced row by default without a config file", async () => {
    await withTempWorkspace(async (directory) => {
      const { fileName, expectedAfter } = await seedFile(directory);
      const result = await runReplace(directory, fileName);

      const execution = getToolExecution(result, "diff-view-replace");
      expect(execution.isError).toBe(false);
      expect(await readFile(path.join(directory, fileName), "utf8")).toBe(expectedAfter);

      const screen = result.tuiRenderedOutput;
      for (let index = 1; index <= SWAPPED_ROWS; index++) {
        expect(screen, `missing swapped row ${index}`).toContain(swappedLine(index));
      }
      expect(readableTerminal(result)).not.toContain("lines omitted");
    });
  }, 120_000);

  test("clips the diff to a sliding window when diffView is compact", async () => {
    await withTempWorkspace(async (directory) => {
      const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(
        path.join(configDirectory, "text-editor.json"),
        JSON.stringify({ renderer: { diffView: "compact" } }),
      );

      const { fileName, expectedAfter } = await seedFile(directory);
      const result = await runReplace(directory, fileName);

      const execution = getToolExecution(result, "diff-view-replace");
      expect(execution.isError).toBe(false);
      expect(await readFile(path.join(directory, fileName), "utf8")).toBe(expectedAfter);

      // While the edit streams in, the compact window clips the growing diff.
      expect(readableTerminal(result)).toContain("lines omitted");
    });
  }, 120_000);
});

/** Strips ANSI escape sequences so streamed terminal output can be asserted. */
function readableTerminal(result: { readonly terminalOutput: string }): string {
  return result.terminalOutput.replace(
    /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\u0007]*\u0007|\x1b[()][0-9A-B]/g,
    "",
  );
}

async function seedFile(
  directory: string,
): Promise<{ readonly fileName: string; readonly expectedAfter: string }> {
  const fillerLines = Array.from({ length: 60 }, (_, index) => `const filler${index} = ${index};`);
  const content = `${fillerLines.join("\n")}\n`;
  const fileName = "diff-view-config.ts";
  await writeFile(path.join(directory, fileName), content, "utf8");

  const lines = content.split("\n");
  const startIndex = 9;
  const expectedLines = [...lines];
  expectedLines.splice(startIndex, SWAPPED_ROWS, ...replacement.split("\n"));
  return {
    fileName,
    expectedAfter: expectedLines.join("\n"),
  };
}

function replaceArguments(fileName: string, content: string) {
  const lines = content.split("\n");
  const startIndex = 9;
  const endIndex = startIndex + SWAPPED_ROWS - 1;
  return {
    path: fileName,
    start: formatLineHashAnchor(startIndex + 1, lines[startIndex]),
    end: formatLineHashAnchor(endIndex + 1, lines[endIndex]),
    text: replacement,
  };
}

async function runReplace(
  directory: string,
  fileName: string,
): Promise<Awaited<ReturnType<BasePiIntegrationTest["run"]>>> {
  const filePath = path.join(directory, fileName);
  const content = await readFile(filePath, "utf8");
  return new BasePiIntegrationTest({
    testName: `diff-view-config-${fileName}`,
    cwd: directory,
    extensions: extensions.paths.map((extension) =>
      extension === defaultTextEditorExtension ? rendererTestStand : extension,
    ),
    tools: ["replace"],
    rawMode: false,
    timeoutMs: 120_000,
    isolateUserResources: true,
    environment: { PI_SKIP_VERSION_CHECK: "1" },
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "diff-view-replace",
            name: "replace",
            arguments: replaceArguments(fileName, content),
            ...interactivePacing,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      // The pause lets the panel finish its typing animation and repaint the
      // completed diff before the harness captures the final frame.
      assistantMessage([text("The diff view check is complete", { delayMs: 0 })], {
        delayMs: 600,
      }),
    ],
  }).run("Replace a block of lines and show the diff");
}
