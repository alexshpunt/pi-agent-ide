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

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const runtimeAnchorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
);
const extensions = createExtensionSet();

afterAll(async () => {
  await extensions.dispose();
});

test("uses a search resource in path as a multi-file delete target", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const firstText = "keep first\nneedle first\n";
    const secondText = "keep second\nneedle second\n";
    await writeFile(first, firstText, "utf8");
    await writeFile(second, secondText, "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-path-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-by-path-anchor",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:line" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search each needle, then delete every matched line through the path anchor");

    expect(getToolExecution(result, "delete-by-path-anchor").isError).toBe(false);

    const finalState = getToolResultText(result, "delete-by-path-anchor");
    for (const value of ["first.txt", "keep first", "second.txt", "keep second"]) {
      expect(finalState).toContain(value);
    }
    expect(finalState).not.toMatch(/^[+ -]\|/mu);
    expect(finalState).not.toMatch(/^[0-9A-HJKMNP-TV-Z]{7}\|/mu);
    expect(finalState).not.toContain("SEARCH#");
    await expect(readFile(first, "utf8")).resolves.toBe("keep first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("keep second\n");
  });
}, 180_000);

test("unions path-resource ranges with an explicit compatible anchor", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    const header = "header line\n";
    await writeFile(first, `${header}needle first\ntail one\n`, "utf8");
    await writeFile(second, `${header}needle second\ntail two\n`, "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-compatible-union",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["read", "search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-lines",
              name: "read",
              arguments: { path: "first.txt", views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-union",
              name: "replace",
              arguments: {
                path: "SEARCH#RUNTIME:1:all:match",
                start: "LINE#RUNTIME:1",
                text: "changed",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search-first", name: "search", arguments: { query: "first" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-begin",
              name: "replace",
              arguments: { path: "SEARCH#RUNTIME:2:all:match", start: "begin", text: "top" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search-second", name: "search", arguments: { query: "second" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-end",
              name: "replace",
              arguments: { path: "SEARCH#RUNTIME:3:all:match", start: "end", text: "bottom" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Combine a path search resource with position anchors");

    expect(getToolExecution(result, "replace-union").isError).toBe(false);
    expect(getToolExecution(result, "replace-begin").isError).toBe(false);
    expect(getToolExecution(result, "replace-end").isError).toBe(false);
    await expect(readFile(first, "utf8")).resolves.toBe("top\nchanged top\ntail one\n");
    await expect(readFile(second, "utf8")).resolves.toBe("changed\nchanged bottom\nbottom\n");
  });
}, 180_000);

test("deletes a final no-LF line through a path resource", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-delete.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-final-delete", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-final",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:line" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete the final line through a search path resource");

    expect(getToolExecution(result, "delete-final").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\n");
  });
}, 180_000);

test("deletes a final no-LF match through an all-match path resource", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-match-delete.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-match-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-final-match-delete",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-final-match",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:match" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete the final match through an all-match search path resource");

    expect(getToolExecution(result, "delete-final-match").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\n");
  });
}, 180_000);

test("deletes adjacent no-LF lines selected by an all-line search path", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "adjacent-lines.txt");
    await writeFile(source, "needle\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-adjacent-lines-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-adjacent-lines",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-adjacent-lines",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:line" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete both adjacent no-LF lines through an all-line search path");

    expect(getToolExecution(result, "delete-adjacent-lines").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("");
  });
}, 180_000);

test("deletes adjacent CRLF lines selected by an all-line search path", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "adjacent-crlf-lines.txt");
    await writeFile(source, "needle\r\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-adjacent-crlf-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-adjacent-crlf",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-adjacent-crlf",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:line" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete both adjacent CRLF lines through an all-line search path");

    expect(getToolExecution(result, "delete-adjacent-crlf").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("");
  });
}, 180_000);

test("deletes only the final line while preserving preceding content", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-line-only.txt");
    await writeFile(source, "header\nneedle\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-line-only",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-final-line-only",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-final-line-only",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:2:line" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete only the final matching line through its per-result line path");

    expect(getToolExecution(result, "delete-final-line-only").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\nneedle\n");
  });
}, 180_000);

test("deletes all non-linewise matches while preserving separators", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "adjacent-match-delete.txt");
    await writeFile(source, "needle\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-adjacent-match-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-adjacent-match",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-adjacent-match",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:match" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete both exact matches while preserving their line separator");

    expect(getToolExecution(result, "delete-adjacent-match").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("\n");
  });
}, 180_000);

test("deletes a final no-LF per-result match through a path resource", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-result-delete.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-result-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-final-result-delete",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-final-result",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:1:match" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete one final search match through its per-result path resource");

    expect(getToolExecution(result, "delete-final-result").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\n");
  });
}, 180_000);

test("deletes a final no-LF line from a position-anchor union", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "union-delete.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-union-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-union-delete", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-union-final",
              name: "delete",
              arguments: { path: "SEARCH#RUNTIME:1:all:line", start: "end" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete a final line using a path and end anchor");

    expect(getToolExecution(result, "delete-union-final").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\n");
  });
}, 180_000);

test("inserts after a final no-LF end anchor with a path union", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-insert.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-insert",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "insert"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-final-insert", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "insert-final",
              name: "insert",
              arguments: { path: "SEARCH#RUNTIME:1:all:line", anchor: "end", text: "inserted" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Insert after a final end anchor");

    expect(getToolExecution(result, "insert-final").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\nneedle\ninserted");
  });
}, 180_000);

test("deduplicates a final no-LF linewise target with end", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-line-dedup",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-final", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-final",
              name: "replace",
              arguments: { path: "SEARCH#RUNTIME:1:all:line", start: "end", text: "changed" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Replace a final line without duplicating the typed range");

    expect(getToolExecution(result, "replace-final").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\nchanged");
  });
}, 180_000);

test("deletes a final no-LF line when exact and linewise endpoints merge", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-exact-delete.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-exact-delete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-final-exact-delete",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-final-exact",
              name: "delete",
              arguments: {
                path: "SEARCH#RUNTIME:1:all:line",
                start: "needle",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Delete a final line by merging an exact anchor with a linewise search path");

    expect(getToolExecution(result, "delete-final-exact").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\n");
  });
}, 180_000);

test("inserts after a final no-LF line when exact and linewise endpoints merge", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "final-exact-insert.txt");
    await writeFile(source, "header\nneedle", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-final-exact-insert",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "insert"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-final-exact-insert",
              name: "search",
              arguments: { query: "needle" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "insert-final-exact",
              name: "insert",
              arguments: {
                anchor: "needle",
                path: "SEARCH#RUNTIME:1:all:line",
                text: "inserted",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Insert after a final line by merging an exact anchor with a linewise search path");

    expect(getToolExecution(result, "insert-final-exact").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("header\nneedle\ninserted");
  });
}, 180_000);

test("inserts into every file selected by a complete search anchor", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    await writeFile(first, "needle first\n", "utf8");
    await writeFile(second, "needle second\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-insert-all",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "insert"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "insert-search-all",
              name: "insert",
              arguments: { path: "SEARCH#RUNTIME:1:all:match", text: "!" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search each needle, then insert punctuation after every exact match");

    expect(getToolExecution(result, "insert-search-all").isError).toBe(false);
    await expect(readFile(first, "utf8")).resolves.toBe("needle! first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("needle! second\n");
  });
}, 180_000);

test("accepts search anchors in both replace span endpoints", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "span.txt");
    await writeFile(source, "before\nneedle first\nneedle second\nafter\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-replace-span",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "needle" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-span",
              name: "replace",
              arguments: {
                start: "SEARCH#RUNTIME:1:1:match",
                end: "SEARCH#RUNTIME:1:2:match",
                text: "merged",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search both needles, then replace the span between their anchors");

    expect(getToolExecution(result, "replace-span").isError).toBe(false);
    // A :match end keeps its exact extent; it does not widen to the rest of its line.
    await expect(readFile(source, "utf8")).resolves.toBe("before\nmerged second\nafter\n");
  });
}, 180_000);

test("copies and moves ranges selected by per-result search anchors", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "source.txt");
    const target = path.join(directory, "target.txt");
    await writeFile(source, "copy me\n", "utf8");
    await writeFile(target, "target\n", "utf8");
    const copyResult = await new PiIntegrationTest({
      testName: "search-anchor-copy",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "copy"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-copy", name: "search", arguments: { query: "copy me" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search-target", name: "search", arguments: { query: "target" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "copy-search-range",
              name: "copy",
              arguments: {
                path: "SEARCH#RUNTIME:1:all:match",
                target: "target.txt",
                targetStart: "target",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search a source and target, then copy the source range after the target anchor");

    expect(getToolExecution(copyResult, "copy-search-range").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("copy me\n");
    await expect(readFile(target, "utf8")).resolves.toBe("target\ncopy me");
    await writeFile(source, "move me\n", "utf8");
    await writeFile(target, "target\n", "utf8");
    const moveResult = await new PiIntegrationTest({
      testName: "search-anchor-move",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "move"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-move", name: "search", arguments: { query: "move me" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "search-move-target",
              name: "search",
              arguments: { query: "target" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "move-search-range",
              name: "move",
              arguments: {
                path: "SEARCH#RUNTIME:1:all:match",
                target: "target.txt",
                targetStart: "target",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search a source and target, then move the source range after the target anchor");

    expect(getToolExecution(moveResult, "move-search-range").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("\n");
    await expect(readFile(target, "utf8")).resolves.toBe("target\nmove me");
  });
}, 180_000);

test("rejects a mutation without a typed target or source anchor", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "source.txt");
    await writeFile(source, "content\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-mutation-missing-source",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "replace-missing-source",
              name: "replace",
              arguments: { text: "changed" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Reject a replace without a path or source anchor");

    expect(getToolExecution(result, "replace-missing-source").isError).toBe(true);
    await expect(readFile(source, "utf8")).resolves.toBe("content\n");
  });
}, 180_000);

test("mutates the complete selection retained by compacted search results", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "limited.txt");
    const sourceText = "needle one\nneedle two\n";
    await writeFile(source, sourceText, "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-mutation-incomplete",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-limited",
              name: "search",
              arguments: { query: "needle", limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-incomplete",
              name: "replace",
              arguments: {
                start: "SEARCH#RUNTIME:1:all:match",
                text: "changed",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Run a compacted search, then replace its complete selection");

    expect(getToolExecution(result, "replace-incomplete").isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe("changed one\nchanged two\n");
  });
}, 180_000);

test("replaces a list of match anchors from different searches in one call", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    await writeFile(first, "alpha one\nalpha two\nalpha three\n", "utf8");
    await writeFile(second, "beta one\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-replace-list",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-alpha", name: "search", arguments: { query: "alpha" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search-beta", name: "search", arguments: { query: "beta" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-list",
              name: "replace",
              arguments: {
                path: [
                  "SEARCH#RUNTIME:1:1:match",
                  "SEARCH#RUNTIME:1:3:match",
                  "SEARCH#RUNTIME:2:1:match",
                ],
                text: "gamma",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Search two words, then replace chosen matches from both results in one call");

    expect(getToolExecution(result, "replace-list").isError).toBe(false);
    await expect(readFile(first, "utf8")).resolves.toBe("gamma one\nalpha two\ngamma three\n");
    await expect(readFile(second, "utf8")).resolves.toBe("gamma one\n");
  });
}, 180_000);

test("rejects a whole anchor list without changes and names the unknown anchor", async () => {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "source.txt");
    await writeFile(source, "alpha one\nalpha two\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-replace-list-unknown",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search", name: "search", arguments: { query: "alpha" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-unknown",
              name: "replace",
              arguments: {
                path: ["SEARCH#RUNTIME:1:1:match", "SEARCH#FFFF:1:match"],
                text: "gamma",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Replace a list that holds one anchor that was never issued");

    expect(getToolExecution(result, "replace-unknown").isError).toBe(true);
    expect(getToolResultText(result, "replace-unknown")).toContain("SEARCH#FFFF:1:match");
    await expect(readFile(source, "utf8")).resolves.toBe("alpha one\nalpha two\n");
  });
}, 180_000);

test("rejects a whole anchor list without changes when one search result is stale", async () => {
  await withTempWorkspace(async (directory) => {
    const first = path.join(directory, "first.txt");
    const second = path.join(directory, "second.txt");
    await writeFile(first, "alpha one\n", "utf8");
    await writeFile(second, "beta one\n", "utf8");
    const result = await new PiIntegrationTest({
      testName: "search-anchor-replace-list-stale",
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "search-alpha", name: "search", arguments: { query: "alpha" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "search-beta", name: "search", arguments: { query: "beta" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "change-second",
              name: "replace",
              arguments: { path: "SEARCH#RUNTIME:2:1:match", text: "delta" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-stale",
              name: "replace",
              arguments: {
                path: ["SEARCH#RUNTIME:1:1:match", "SEARCH#RUNTIME:2:1:match"],
                text: "gamma",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run("Replace a list after one of its source files changed");

    expect(getToolExecution(result, "change-second").isError).toBe(false);
    expect(getToolExecution(result, "replace-stale").isError).toBe(true);
    await expect(readFile(first, "utf8")).resolves.toBe("alpha one\n");
    await expect(readFile(second, "utf8")).resolves.toBe("delta one\n");
  });
}, 180_000);

async function runReferenceList(
  name: string,
  files: Record<string, string>,
  queries: readonly string[],
  tool: string,
  tools: readonly string[],
  args: Record<string, unknown>,
) {
  return withTempWorkspace(async (directory) => {
    for (const [file, content] of Object.entries(files))
      await writeFile(path.join(directory, file), content, "utf8");
    const result = await new PiIntegrationTest({
      testName: name,
      cwd: directory,
      extensions: [...extensions.paths, runtimeAnchorExtension],
      tools: ["search", ...tools],
      conversation: [
        ...queries.map((query, index) =>
          assistantMessage(
            [toolCall({ id: `search-${index}`, name: "search", arguments: { query } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([toolCall({ id: "act", name: tool, arguments: args })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("done")]),
      ],
    }).run(`Search, then ${tool} a list of references`);
    const contents: Record<string, string> = {};
    for (const file of Object.keys(files))
      contents[file] = await readFile(path.join(directory, file), "utf8");
    return {
      failed: getToolExecution(result, "act").isError,
      text: getToolResultText(result, "act"),
      contents,
    };
  });
}

test("inserts after every reference of a list from different searches", async () => {
  const run = await runReferenceList(
    "reference-list-insert",
    { "a.txt": "one\nneedle\n", "b.txt": "pin\n" },
    ["needle", "pin"],
    "insert",
    ["insert"],
    {
      path: ["SEARCH#RUNTIME:1:1:line", "SEARCH#RUNTIME:2:1:line"],
      text: "added",
    },
  );
  expect(run.failed).toBe(false);
  expect(run.contents).toEqual({ "a.txt": "one\nneedle\nadded", "b.txt": "pin\nadded" });
}, 180_000);

test("deletes every reference of a list from different searches", async () => {
  const run = await runReferenceList(
    "reference-list-delete",
    { "a.txt": "one\nneedle\ntwo\n", "b.txt": "pin\nkeep\n" },
    ["needle", "pin"],
    "delete",
    ["delete"],
    { path: ["SEARCH#RUNTIME:1:1:line", "SEARCH#RUNTIME:2:1:line"] },
  );
  expect(run.failed).toBe(false);
  expect(run.contents).toEqual({ "a.txt": "one\ntwo\n", "b.txt": "keep\n" });
}, 180_000);

test("copies each referenced source into the matching referenced target", async () => {
  const run = await runReferenceList(
    "reference-list-copy",
    { "src.txt": "AAA BBB\n", "dst.txt": "x1 x2\n" },
    ["AAA", "BBB", "x1", "x2"],
    "copy",
    ["copy"],
    {
      path: ["SEARCH#RUNTIME:1:1:match", "SEARCH#RUNTIME:2:1:match"],
      target: ["SEARCH#RUNTIME:3:1:match", "SEARCH#RUNTIME:4:1:match"],
    },
  );
  expect(run.failed, run.text).toBe(false);
  expect(run.contents["src.txt"]).toBe("AAA BBB\n");
  expect(run.contents["dst.txt"]).toBe("AAA BBB\n");
}, 180_000);

test("rejects a plain path in a reference list and names it", async () => {
  const run = await runReferenceList(
    "reference-list-plain-path",
    { "a.txt": "needle\n" },
    ["needle"],
    "replace",
    ["replace"],
    { path: ["SEARCH#RUNTIME:1:1:match", "a.txt"], text: "x" },
  );
  expect(run.failed).toBe(true);
  expect(run.text).toContain("Reference a.txt cannot be used");
  expect(run.text).not.toContain("Unsupported result input");
  expect(run.contents["a.txt"]).toBe("needle\n");
}, 180_000);

test("rejects an unknown reference in a delete list without changes", async () => {
  const run = await runReferenceList(
    "reference-list-delete-unknown",
    { "a.txt": "needle\nkeep\n" },
    ["needle"],
    "delete",
    ["delete"],
    { path: ["SEARCH#RUNTIME:1:1:line", "SEARCH#FFFF:1:line"] },
  );
  expect(run.failed).toBe(true);
  expect(run.text).toContain("SEARCH#FFFF:1:line");
  expect(run.contents["a.txt"]).toBe("needle\nkeep\n");
}, 180_000);
