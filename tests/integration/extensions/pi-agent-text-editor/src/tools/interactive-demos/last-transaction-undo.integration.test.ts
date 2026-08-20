import path from "node:path";
import { readFile } from "node:fs/promises";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
);
const overwriteExtension = path.resolve(
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.ts",
);
const undoExtension = path.resolve("src/plugins/pi-agent-ide-changes/index.ts");
const demoFileName = "scheduler-last-transaction-demo.ts";
const marker = "const MAX_PARALLEL_JOBS = 8;";
const replacement = "const MAX_PARALLEL_JOBS = 24;";
const baseline = buildSchedulerSource();
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 512 }, delayMs: 0 };

afterAll(() => extensions.dispose());

describe("interactive text editor demos", () => {
  test("shows last transaction undo through the standard mutation diff", async () => {
    await withTempWorkspace(async (directory) => {
      const file = await createFixture(directory, demoFileName, baseline);
      const line = lineNumber(baseline, marker);
      const replaceCallId = "demo-last-transaction-edit";
      const undoCallId = "demo-last-transaction-undo";
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-last-transaction-undo",
        cwd: directory,
        extensions: [
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          overwriteExtension,
          undoExtension,
        ],
        tools: ["replace", "undo"],
        rawMode: false,
        timeoutMs: 180_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: replaceCallId,
                name: "replace",
                arguments: {
                  path: demoFileName,
                  start: formatLineHashAnchor(line, marker),
                  text: replacement,
                },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: undoCallId,
                name: "undo",
                arguments: { file: demoFileName, change: "last" },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("The last transaction undo demo is complete", { delayMs: 0 })]),
        ],
      }).run("Change the scheduler limit, then undo the complete last transaction");

      expect(getToolExecution(result, replaceCallId).isError).toBe(false);
      expect(getToolExecution(result, undoCallId).isError).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toBe(baseline);

      const panel = mutationPanel(result.tuiRenderedOutput, `undo ${demoFileName}:last +0 ~1 -0`);
      expect(panel).toMatch(new RegExp(`${line}\\s+~\\s+${escapeRegExp(marker)}`, "u"));
      expect(panel).not.toContain(replacement);
    });
  }, 180_000);
});

function mutationPanel(rendered: string, header: string): string {
  const panelStart = rendered.indexOf("╭─", rendered.indexOf(header));
  const panelEnd = rendered.indexOf("╯", panelStart);

  if (panelStart === -1 || panelEnd === -1) {
    throw new Error(`No mutation panel follows ${header}`);
  }

  return rendered.slice(panelStart, panelEnd + 1);
}

function lineNumber(content: string, line: string): number {
  const index = content.indexOf(line);

  if (index === -1) {
    throw new Error(`Missing demo line ${line}`);
  }

  return content.slice(0, index).split("\n").length;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildSchedulerSource(): string {
  const queues = Array.from({ length: 60 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return `    { name: "worker-${number}", queue: "jobs-${number}", concurrency: ${(index % 6) + 1} },`;
  });

  return [
    "export interface WorkerQueue",
    "{",
    "    readonly name: string;",
    "    readonly queue: string;",
    "    readonly concurrency: number;",
    "}",
    "",
    marker,
    "const DEFAULT_RETRY_LIMIT = 4;",
    "",
    "export const workerQueues = [",
    ...queues,
    "] as const satisfies readonly WorkerQueue[];",
    "",
    "export function schedulerSummary(): string",
    "{",
    "    return `${workerQueues.length} queues, max=${MAX_PARALLEL_JOBS}`;",
    "}",
    "",
  ].join("\n");
}
