import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createSearchSessionId, type TextSearchMatch } from "pi-agent-search-text/search-session";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
);
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 256 }, delayMs: 0 };

const files = {
  "src/api/queue.ts": [
    "export interface QueueOptions",
    "{",
    "    readonly legacyQueue: string;",
    "}",
    "",
    "export function openQueue(options: QueueOptions): string",
    "{",
    "    return options.legacyQueue;",
    "}",
    "",
  ].join("\n"),
  "src/runtime/worker.ts": [
    'import type { QueueOptions } from "../api/queue.js";',
    "",
    'export const workerQueue: QueueOptions = { legacyQueue: "jobs" };',
    'export const queueKey = "legacyQueue";',
    "",
  ].join("\n"),
  "src/runtime/status.ts": [
    "export function queueStatus(legacyQueue: string): string",
    "{",
    "    return `ready:${legacyQueue}`;",
    "}",
    "",
  ].join("\n"),
} as const;

afterAll(() => extensions.dispose());

describe("interactive text editor demos", () => {
  test("previews exact search anchors and replaces all matches across files", async () => {
    await withTempWorkspace(async (directory) => {
      for (const [file, content] of Object.entries(files)) {
        const absolute = path.join(directory, file);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
      }

      const matches = Object.entries(files).flatMap(([file, content]) =>
        content.split("\n").flatMap((lineText, lineIndex) => {
          const found: TextSearchMatch[] = [];
          let from = 0;

          for (;;) {
            const startColumn = lineText.indexOf("legacyQueue", from);

            if (startColumn === -1) {
              return found;
            }

            found.push({
              source: path.join(directory, file),
              lineNumber: lineIndex + 1,
              startColumn,
              endColumn: startColumn + "legacyQueue".length,
              matchedText: "legacyQueue",
              lineText,
            });
            from = startColumn + "legacyQueue".length;
          }
        }),
      );
      const searchId = createSearchSessionId("legacyQueue", matches, directory);
      const allAnchor = `SEARCH#${searchId}:all`;
      const searchCallId = "demo-search-preview";
      const replaceCallId = "demo-search-replace-all";
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-search-replace",
        cwd: directory,
        extensions: extensions.paths.map((extension) =>
          extension === defaultTextEditorExtension ? rendererTestStand : extension,
        ),
        tools: ["search", "replace"],
        rawMode: false,
        timeoutMs: 180_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: searchCallId,
                name: "search",
                arguments: { query: "legacyQueue", path: "src", include: "**/*.ts" },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: replaceCallId,
                name: "replace",
                arguments: { start: allAnchor, text: "queueName" },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("The search and replace demo is complete", { delayMs: 0 })]),
        ],
      }).run("Preview every legacy queue reference, then rename the complete result set");

      expect(getToolExecution(result, searchCallId).isError).toBe(false);
      expect(getToolResultText(result, searchCallId)).toContain(
        `${allAnchor} — 6 matches in 3 files`,
      );
      expect(getToolExecution(result, replaceCallId).isError).toBe(false);
      const rendered = result.tuiRenderedOutput;
      const searchView = rendered.slice(
        rendered.indexOf('search "legacyQueue"'),
        rendered.indexOf("replace 3 files:"),
      );
      expect(searchView).toContain("6 matches in 3 files");
      expect(searchView).toMatch(/src\/api\/queue\.ts\s+2/u);
      expect(searchView).toMatch(/src\/runtime\/status\.ts\s+2/u);
      expect(searchView).toMatch(/src\/runtime\/worker\.ts\s+2/u);
      expect(searchView).toContain("legacyQueue");
      expect(searchView).not.toContain("SEARCH#");
      expect(searchView).not.toContain("⟦");
      expect(rendered).toContain("queueName");

      for (const [file, content] of Object.entries(files)) {
        await expect(readFile(path.join(directory, file), "utf8")).resolves.toBe(
          content.replaceAll("legacyQueue", "queueName"),
        );
      }
    });
  }, 180_000);
});
