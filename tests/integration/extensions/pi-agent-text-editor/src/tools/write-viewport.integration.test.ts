import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
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
const writtenLines = Array.from(
  { length: 24 },
  (_, index) => `written line ${String(index + 1).padStart(2, "0")}`,
);
const content = `${writtenLines.join("\n")}\n`;

const firstLine = writtenLines[0] ?? "";
const lastLine = writtenLines.at(-1) ?? "";

afterAll(() => extensions.dispose());

describe("write diff viewport", () => {
  test("shows the complete write while the tool is collapsed", async () => {
    await withTempWorkspace(async (directory) => {
      const result = await runWrite(directory, false);

      expect(getToolExecution(result, "write-viewport").isError).toBe(false);
      expect(await readFile(path.join(directory, "generated.txt"), "utf8")).toBe(content);
      const panel = writePanel(result.tuiRenderedOutput);
      expect(panel).toContain(firstLine);
      expect(panel).toContain(lastLine);
      expect(panel).not.toContain("lines omitted");
    });
  }, 120_000);

  test("shows the complete write when tools are expanded", async () => {
    await withTempWorkspace(async (directory) => {
      const result = await runWrite(directory, true);

      expect(getToolExecution(result, "write-viewport").isError).toBe(false);
      const panel = writePanel(result.tuiRenderedOutput);
      expect(panel).toContain(firstLine);
      expect(panel).toContain(lastLine);
      expect(panel).not.toContain("lines omitted");
    });
  }, 120_000);
});

function writePanel(output: string): string {
  const start = output.indexOf("write generated.txt");
  const end = output.indexOf("POSTFLIGHT STARTED", start);
  return output.slice(start, end === -1 ? undefined : end);
}

async function runWrite(directory: string, expanded: boolean) {
  return new PiIntegrationTest({
    testName: `write-viewport-${expanded ? "expanded" : "collapsed"}`,
    cwd: directory,
    extensions: extensions.paths.map((extension) =>
      extension === defaultTextEditorExtension ? rendererTestStand : extension,
    ),
    tools: ["write"],
    rawMode: false,
    timeoutMs: 120_000,
    isolateUserResources: true,
    environment: {
      PI_AGENT_IDE_TEST_EXPANDED: expanded ? "1" : "0",
      PI_SKIP_VERSION_CHECK: "1",
    },
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "write-viewport",
            name: "write",
            arguments: { path: "generated.txt", content },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("The write viewport check is complete", { delayMs: 0 })], {
        delayMs: 600,
      }),
    ],
  }).run("Write the generated file");
}
