import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
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

const runtimeAnchorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
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
  "src/api/worker.ts": [
    'import type { QueueOptions } from "./queue.js";',
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

      const runtimeAllAnchor = "SEARCH#RUNTIME:1:all:match";
      const searchCallId = "demo-search-preview";
      const replaceCallId = "demo-search-replace-all";
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-search-replace",
        cwd: directory,
        extensions: [
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          runtimeAnchorExtension,
        ],
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
                arguments: { start: runtimeAllAnchor, text: "queueName" },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("The search and replace demo is complete", { delayMs: 0 })]),
        ],
      }).run("Preview every legacy queue reference, then rename the complete result set");

      const searchExecution = getToolExecution(result, searchCallId);
      expect(searchExecution.isError).toBe(false);
      const searchId = runtimeSearchSessionId(getToolExecutionDetails(searchExecution));
      expect(getToolResultText(result, searchCallId)).toContain(
        `SEARCH#${searchId}:all:match — 6 matches in 3 files`,
      );
      expect(getToolExecution(result, replaceCallId).isError).toBe(false);
      const rendered = result.tuiRenderedOutput;
      const searchStart = rendered.indexOf('search "legacyQueue"');
      const replaceStart = rendered.indexOf("replace", searchStart + 1);
      const searchView = rendered.slice(searchStart, replaceStart);
      const replaceHeader = rendered.slice(replaceStart, rendered.indexOf("\n", replaceStart));
      expect(searchView).toContain("include **/*.ts");
      expect(searchView).toContain("6 matches in 3 files");
      expect(searchView).toMatch(/src\/api\/queue\.ts\s+2/u);
      expect(searchView).toMatch(/src\/runtime\/status\.ts\s+2/u);
      expect(searchView).toMatch(/src\/api\/worker\.ts\s+2/u);
      expect(searchView).toContain("legacyQueue");
      expect(searchView).not.toContain("SEARCH#");
      expect(searchView).not.toContain("⟦");

      expect(replaceHeader).toContain("all matches");
      expect(replaceHeader).not.toContain("SEARCH#");
      expect(rendered).toContain("queueName");

      expectHighlightedSearchBackgrounds(result.terminalOutput, "legacyQueue");

      for (const [file, content] of Object.entries(files)) {
        await expect(readFile(path.join(directory, file), "utf8")).resolves.toBe(
          content.replaceAll("legacyQueue", "queueName"),
        );
      }
    });
  }, 180_000);
});

function expectHighlightedSearchBackgrounds(terminalOutput: string, match: string): void {
  const backgroundReset = "\u001B[49m";
  let highlightedMatches = 0;
  let offset = 0;

  while (offset < terminalOutput.length) {
    const matchAt = terminalOutput.indexOf(match, offset);
    if (matchAt === -1) {
      break;
    }

    const rowStart = terminalOutput.lastIndexOf("\n", matchAt) + 1;
    const enclosingBackground = terminalOutput
      .slice(rowStart, matchAt)
      .match(/\u001B\[48(?:;\d+)+m/u)?.[0];
    const suffix = terminalOutput.slice(matchAt + match.length, matchAt + match.length + 64);
    const resetAt = suffix.indexOf(backgroundReset);
    if (resetAt !== -1 && enclosingBackground !== undefined) {
      highlightedMatches++;
      expect(suffix.slice(resetAt + backgroundReset.length).startsWith(enclosingBackground)).toBe(
        true,
      );
    }
    offset = matchAt + match.length;
  }

  expect(highlightedMatches).toBeGreaterThan(0);
}

function runtimeSearchSessionId(details: unknown): string {
  if (
    typeof details === "object" &&
    details !== null &&
    "payload" in details &&
    typeof details.payload === "object" &&
    details.payload !== null &&
    "sessionId" in details.payload &&
    typeof details.payload.sessionId === "string"
  ) {
    return details.payload.sessionId;
  }

  throw new Error("Search result did not expose its runtime session ID.");
}
