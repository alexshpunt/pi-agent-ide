import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const runtimeAnchorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
);
const extensions = createExtensionSet();

afterAll(async () => {
  await extensions.dispose();
});

test("reads each explicit search selector as an ordered resource chunk", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const firstText = "first header\nneedle first\nfirst tail\n";
    const secondText = "second header\nneedle second\nsecond tail\n";
    await writeFile(first, firstText, "utf8");
    await writeFile(second, secondText, "utf8");
    const selectors = [
      "RUNTIME:1:1:line",
      "RUNTIME:1:1:match",
      "RUNTIME:1:all:line",
      "RUNTIME:1:all:match",
    ];
    const result = await new PiIntegrationTest({
      testName: "search-anchor-read-selectors",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          selectors.map((selector, index) =>
            toolCall({
              id: `read-${index}`,
              name: "read",
              arguments: { path: `SEARCH#${selector}`, offset: 1, limit: 1 },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search for needle, then read every explicit search anchor selector");

    for (const [index, selector] of selectors.entries()) {
      const callId = `read-${index}`;
      expect(getToolExecution(result, callId).isError, selector).toBe(false);
      expect(getToolResultText(result, callId), selector).toContain("needle");
    }
    expect(getToolResultText(result, "read-2")).toContain("needle first");
    expect(getToolResultText(result, "read-2")).toContain("needle second");
  });
}, 180_000);

test("refreshes a complete all-result read anchor after a matched file changes", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const firstText = "needle first\n";
    const secondText = "needle second\n";
    await writeFile(first, firstText, "utf8");
    await writeFile(second, secondText, "utf8");
    const anchor = "SEARCH#RUNTIME:1:all:match";
    const changedFirst = "changed context\nneedle first changed\n";
    const result = await new PiIntegrationTest({
      testName: "search-anchor-read-refresh",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "write", "read"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "change",
              name: "write",
              arguments: { path: "first.txt", content: changedFirst },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "read-refresh", name: "read", arguments: { path: anchor } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search, change a matched file, then read the complete search anchor");

    expect(getToolExecution(result, "read-refresh").isError).toBe(false);
    const output = getToolResultText(result, "read-refresh");
    expect(output).toContain("needle first changed");
    expect(output).toContain("needle second");
  });
}, 180_000);

test("keeps a per-result search read anchor snapshot-only after a matched file changes", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "first.txt");
    await writeFile(source, "needle first\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-read-stale-result",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "write", "read"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "change",
              name: "write",
              arguments: { path: "first.txt", content: "changed\nneedle first\n" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-stale",
              name: "read",
              arguments: { path: "SEARCH#RUNTIME:1:1:match" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search, change the matched file, then read the per-result anchor");

    expect(getToolExecution(result, "read-stale").isError).toBe(true);
    await expect(readFile(source, "utf8")).resolves.toBe("changed\nneedle first\n");
  });
}, 180_000);

test("does not expose all selectors for an incomplete search", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "limited.txt");
    const sourceText = "needle one\nneedle two\n";
    await writeFile(source, sourceText, "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-read-incomplete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search",
              name: "search",
              arguments: { query: "needle", limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-all",
              name: "read",
              arguments: { path: "SEARCH#RUNTIME:1:all:match" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Run a limited search, then reject its complete anchor");

    expect(getToolExecution(result, "read-all").isError).toBe(true);
  });
}, 180_000);
