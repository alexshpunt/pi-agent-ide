import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

import { createSearchSessionId, type TextSearchMatch } from "pi-agent-search-text/search-session";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const extensions = createExtensionSet();
const restoreSharedRunner = forceStandaloneIntegrationFile();

afterAll(async () => {
  await extensions.dispose();
  restoreSharedRunner();
});

describe("pi-agent-text-editor search", () => {
  test("renders explicit search anchors with a legend and paired result targets", async () => {
    await withTempWorkspace(async (directory) => {
      const source = path.join(directory, "anchors.txt");
      const firstLine = "legacyName = legacyName;";
      const secondLine = "legacyName alone";
      const sourceText = `${firstLine}\n${secondLine}\n`;
      await writeFile(source, sourceText, "utf8");
      const matches = [
        searchMatchAt(source, 1, firstLine, "legacyName", 0),
        searchMatchAt(source, 1, firstLine, "legacyName", 1),
        searchMatchAt(source, 2, secondLine, "legacyName"),
      ];
      const searchId = createSearchSessionId("legacyName", matches, directory);
      const result = await new PiIntegrationTest({
        testName: "search-explicit-anchor-output",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search-explicit-anchor-output",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Search for legacyName and inspect its edit anchors");

      expect(searchId).toMatch(/^[A-F0-9]{4}$/u);
      const output = getToolResultText(result, "search-explicit-anchor-output");
      expect(getToolExecution(result, "search-explicit-anchor-output").isError).toBe(false);
      const legend = output.split("\n").slice(0, 4).join("\n");
      for (const term of [":line", ":match", ":all:line", ":all:match"]) {
        expect(legend).toContain(term);
      }
      for (const index of [1, 2, 3]) {
        expect(output).toContain(`SEARCH#${searchId}:${index}:line`);
        expect(output).toContain(`SEARCH#${searchId}:${index}:match`);
      }
      expect(output).toContain(`SEARCH#${searchId}:all:line`);
      expect(output).toContain(`SEARCH#${searchId}:all:match`);
      expect(output).not.toMatch(
        new RegExp(`SEARCH#${searchId}:(?:all|[1-9]\\d*)(?!:(?:line|match))(?=\\s|$)`, "u"),
      );
    });
  }, 180_000);

  test("applies explicit per-result and all-result line or match targets", async () => {
    const sourceText = "legacyName = legacyName;\nlegacyName alone\n";
    await runExplicitSearchReplacement(
      "search-anchor-per-match",
      sourceText,
      "SEARCH_SELECTOR:1:match",
      "UPDATED = legacyName;\nlegacyName alone\n",
    );
    await runExplicitSearchReplacement(
      "search-anchor-per-line",
      sourceText,
      "SEARCH_SELECTOR:1:line",
      "UPDATED\nlegacyName alone\n",
    );
    await runExplicitSearchReplacement(
      "search-anchor-all-match",
      sourceText,
      "SEARCH_SELECTOR:all:match",
      "UPDATED = UPDATED;\nUPDATED alone\n",
    );
    await runExplicitSearchReplacement(
      "search-anchor-all-line",
      sourceText,
      "SEARCH_SELECTOR:all:line",
      "UPDATED\nUPDATED\n",
    );
  }, 180_000);

  test("deletes whole line anchors without leaving newline fragments", async () => {
    await runExplicitSearchDeletion(
      "search-anchor-delete-lf",
      "legacyName first\nkeep\n",
      "keep\n",
    );
    await runExplicitSearchDeletion(
      "search-anchor-delete-crlf",
      "legacyName first\r\nkeep\r\n",
      "keep\r\n",
    );
    await runExplicitSearchDeletion(
      "search-anchor-delete-final-unterminated",
      "keep\nlegacyName final",
      "keep",
    );
  }, 180_000);

  test("rejects bare per-result and all-result anchors without changing the file", async () => {
    await withTempWorkspace(async (directory) => {
      const source = path.join(directory, "bare.txt");
      const sourceText = "legacyName = legacyName;\nlegacyName alone\n";
      await writeFile(source, sourceText, "utf8");
      const firstLine = "legacyName = legacyName;";
      const secondLine = "legacyName alone";
      const matches = [
        searchMatchAt(source, 1, firstLine, "legacyName", 0),
        searchMatchAt(source, 1, firstLine, "legacyName", 1),
        searchMatchAt(source, 2, secondLine, "legacyName"),
      ];
      const searchId = createSearchSessionId("legacyName", matches, directory);
      const result = await new PiIntegrationTest({
        testName: "search-bare-anchor-rejection",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search-bare-anchor",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-bare-result",
                name: "replace",
                arguments: { start: `SEARCH#${searchId}:1`, text: "BROKEN" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-bare-all",
                name: "replace",
                arguments: { start: `SEARCH#${searchId}:all`, text: "BROKEN" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Reject legacy bare search anchors");

      expect(getToolExecution(result, "replace-bare-result").isError).toBe(true);
      expect(getToolExecution(result, "replace-bare-all").isError).toBe(true);
      await expect(readFile(source, "utf8")).resolves.toBe(sourceText);
    });
  }, 180_000);

  test("previews exact regex matches and replaces the complete search across files", async () => {
    await withTempWorkspace(async (directory) => {
      const first = path.join(directory, "src", "first.ts");
      const second = path.join(directory, "src", "second.ts");
      const ignored = path.join(directory, "src", "ignored", "ignored.ts");
      const markdown = path.join(directory, "notes.md");
      const firstText = [
        "const legacyName = 1;",
        "LEGACYVALUE();",
        "const legacyNameExtra = 2;",
        "",
      ].join("\n");
      const secondText = "export const selected = legacyName;\n";
      await mkdir(path.dirname(ignored), { recursive: true });
      await writeFile(first, firstText, "utf8");
      await writeFile(second, secondText, "utf8");
      await writeFile(ignored, "legacyName\n", "utf8");
      await writeFile(markdown, "legacyName\n", "utf8");

      const query = "legacy(?:Name|Value)";
      const matches = [
        searchMatch(first, 1, firstText.split("\n")[0], "legacyName"),
        searchMatch(first, 2, firstText.split("\n")[1], "LEGACYVALUE"),
        searchMatch(second, 1, secondText.trimEnd(), "legacyName"),
      ];
      const searchId = createSearchSessionId(query, matches, directory, {
        query,
        regex: true,
        path: "src",
        include: "**/*.ts",
        exclude: "**/ignored/**",
        wholeWord: true,
        limit: 100,
      });
      const allAnchor = `SEARCH#${searchId}:all:match`;
      const searchCallId = "search-regex-preview";
      const replaceCallId = "replace-search-all";
      const result = await new PiIntegrationTest({
        testName: "text-editor-search-replace-all",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search", "replace"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: searchCallId,
                name: "search",
                arguments: {
                  query: `regex:${query}`,
                  path: "src",
                  include: "**/*.ts",
                  exclude: "**/ignored/**",
                  caseSensitive: false,
                  wholeWord: true,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: replaceCallId,
                name: "replace",
                arguments: { start: allAnchor, text: "modernName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Find the legacy names, preview them, then replace every exact result");

      const searchOutput = getToolResultText(result, searchCallId);
      expect(getToolExecution(result, searchCallId).isError).toBe(false);
      expect(searchOutput).toContain(`${allAnchor} — 3 matches in 2 files`);
      expect(searchOutput).toContain(`SEARCH#${searchId}:1:match`);
      expect(searchOutput).toContain("⟦legacyName⟧");
      expect(searchOutput).toContain("⟦LEGACYVALUE⟧");
      expect(searchOutput).not.toContain("legacyNameExtra");
      expect(searchOutput).not.toContain("ignored.ts");
      expect(searchOutput).not.toContain("notes.md");
      const replaceExecution = getToolExecution(result, replaceCallId);
      expect(replaceExecution.isError).toBe(false);
      expect(
        (getToolExecutionDetails(replaceExecution) as { results?: readonly unknown[] }).results,
      ).toHaveLength(2);
      await expect(readFile(first, "utf8")).resolves.toBe(
        firstText.replace("legacyName", "modernName").replace("LEGACYVALUE", "modernName"),
      );
      await expect(readFile(second, "utf8")).resolves.toBe("export const selected = modernName;\n");
      await expect(readFile(ignored, "utf8")).resolves.toBe("legacyName\n");
      await expect(readFile(markdown, "utf8")).resolves.toBe("legacyName\n");
    });
  }, 180_000);

  test("scopes a multi-file all-result anchor to an explicit path", async () => {
    await withTempWorkspace(async (directory) => {
      const first = path.join(directory, "first.txt");
      const second = path.join(directory, "second.txt");
      const unrelated = path.join(directory, "unrelated.txt");
      const firstText = "legacyName in first\nlegacyName again\n";
      const secondText = "legacyName in second\n";
      await writeFile(first, firstText, "utf8");
      await writeFile(second, secondText, "utf8");
      await writeFile(unrelated, "no match\n", "utf8");
      const matches = [
        searchMatch(first, 1, "legacyName in first", "legacyName"),
        searchMatch(first, 2, "legacyName again", "legacyName"),
        searchMatch(second, 1, secondText.trimEnd(), "legacyName"),
      ];
      const searchId = createSearchSessionId("legacyName", matches, directory);
      const allAnchor = `SEARCH#${searchId}:all:match`;
      const result = await new PiIntegrationTest({
        testName: "text-editor-search-all-explicit-path",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search-before-scoped-replace",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-with-unrelated-path",
                name: "replace",
                arguments: { path: unrelated, start: allAnchor, text: "modernName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-with-explicit-path",
                name: "replace",
                arguments: { path: first, start: allAnchor, text: "modernName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Search all files, then replace every result in one explicit file");

      expect(getToolExecution(result, "replace-with-unrelated-path").isError).toBe(true);
      expect(getToolExecution(result, "replace-with-explicit-path").isError).toBe(false);
      await expect(readFile(first, "utf8")).resolves.toBe(
        "modernName in first\nmodernName again\n",
      );
      await expect(readFile(second, "utf8")).resolves.toBe(secondText);
      await expect(readFile(unrelated, "utf8")).resolves.toBe("no match\n");
    });
  }, 180_000);

  test("does not inherit the previous file for a multi-file search replacement", async () => {
    await withTempWorkspace(async (directory) => {
      const previous = path.join(directory, "previous.txt");
      const first = path.join(directory, "first.txt");
      const second = path.join(directory, "second.txt");
      const firstText = "legacyName in first\n";
      const secondText = "legacyName in second\n";
      await writeFile(previous, "before\n", "utf8");
      await writeFile(first, firstText, "utf8");
      await writeFile(second, secondText, "utf8");
      const matches = [
        searchMatch(first, 1, firstText.trimEnd(), "legacyName"),
        searchMatch(second, 1, secondText.trimEnd(), "legacyName"),
      ];
      const searchId = createSearchSessionId("legacyName", matches, directory);
      const allAnchor = `SEARCH#${searchId}:all:match`;
      const result = await new PiIntegrationTest({
        testName: "text-editor-search-all-ignores-inherited-path",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["write", "search", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "establish-previous-file",
                name: "write",
                arguments: { path: previous, content: "after\n" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "search-after-previous-file",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-with-search-all-only",
                name: "replace",
                arguments: { start: allAnchor, text: "modernName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Edit one file, search the project, then replace every search result without a path");

      expect(getToolExecution(result, "replace-with-search-all-only").isError).toBe(false);
      await expect(readFile(previous, "utf8")).resolves.toBe("after\n");
      await expect(readFile(first, "utf8")).resolves.toBe("modernName in first\n");
      await expect(readFile(second, "utf8")).resolves.toBe("modernName in second\n");
    });
  }, 180_000);

  test("refreshes the complete search before writing when one matched file changed", async () => {
    await withTempWorkspace(async (directory) => {
      const first = path.join(directory, "first.txt");
      const second = path.join(directory, "second.txt");
      const firstText = "legacyName in first\n";
      const secondText = "legacyName in second\n";
      await writeFile(first, firstText, "utf8");
      await writeFile(second, secondText, "utf8");

      const matches = [
        searchMatch(first, 1, firstText.trimEnd(), "legacyName"),
        searchMatch(second, 1, secondText.trimEnd(), "legacyName"),
      ];
      const searchId = createSearchSessionId("legacyName", matches, directory);
      const allAnchor = `SEARCH#${searchId}:all:match`;
      const changedFirst = "changed outside the search snapshot\nlegacyName in first\n";
      const result = await new PiIntegrationTest({
        testName: "text-editor-search-refresh-all",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search", "write", "replace"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search-before-change",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "change-matched-file",
                name: "write",
                arguments: { path: "first.txt", content: changedFirst },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "replace-stale-search",
                name: "replace",
                arguments: { start: allAnchor, text: "modernName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Search, change one matched file, then reuse the complete search anchor");

      expect(getToolResultText(result, "search-before-change")).toContain(allAnchor);
      expect(getToolExecution(result, "replace-stale-search").isError).toBe(false);
      await expect(readFile(first, "utf8")).resolves.toBe(
        "changed outside the search snapshot\nmodernName in first\n",
      );
      await expect(readFile(second, "utf8")).resolves.toBe("modernName in second\n");
    });
  }, 180_000);

  test("restores the search result panel from the persisted session", async () => {
    await withTempWorkspace(async (directory) => {
      const source = path.join(directory, "src", "persisted.ts");
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(
        source,
        ['export const legacyName = "first";', "export const selected = legacyName;", ""].join(
          "\n",
        ),
        "utf8",
      );
      const firstRun = await new PiIntegrationTest({
        testName: "text-editor-search-renderer-persisted",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search"],
        rawMode: false,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "persisted-search",
                name: "search",
                arguments: { query: "legacyName" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Search complete")]),
        ],
      }).run("Find every legacy name");
      const sessionFile = path.join(directory, "persisted-search-session.jsonl");
      await writeFile(sessionFile, await readSessionArtifact(firstRun.artifacts.run), "utf8");
      const piCommand = path.join(directory, "resume-search-session");
      await writeFile(
        piCommand,
        `#!/usr/bin/env bash\nexec pi --session ${JSON.stringify(sessionFile)} "$@"\n`,
        "utf8",
      );
      await chmod(piCommand, 0o755);
      const resumed = await runInSeparatePi(() =>
        new PiIntegrationTest({
          testName: "text-editor-search-renderer-resumed",
          cwd: directory,
          extensions: extensions.paths,
          tools: ["search"],
          piCommand,
          rawMode: false,
          conversation: [assistantMessage([text("Session restored")])],
        }).run("Continue after restoring the search session"),
      );
      const rendered = resumed.tuiRenderedOutput;
      const searchView = rendered.slice(rendered.indexOf('search "legacyName"'));

      expect(searchView).toContain("2 matches in 1 file");
      expect(searchView).toMatch(/src\/persisted\.ts\s+2/u);
      expect(searchView).toContain("export const legacyName");
      expect(searchView).toContain("export const selected = legacyName");
      expect(searchView).toContain("╭");
      expect(searchView).not.toContain("SEARCH#");
      expect(searchView).not.toContain("⟦");
    });
  }, 180_000);

  test("routes files and AST protocols through their installed resolvers", async () => {
    await withTempWorkspace(async (directory) => {
      const source = path.join(directory, "src", "queue.ts");
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, 'export const legacyQueue = { name: "jobs" };\n', "utf8");
      const result = await new PiIntegrationTest({
        testName: "search-protocol-routing",
        cwd: directory,
        extensions: extensions.paths,
        tools: ["search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "search-files",
                name: "search",
                arguments: { query: "files:queue", path: "src" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "search-ast",
                name: "search",
                arguments: { query: "ast:legacyQueue", path: "src" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("done")]),
        ],
      }).run("Search paths, then search the matching syntax tree");

      expect(getToolExecution(result, "search-files").isError).toBe(false);
      expect(getToolResultText(result, "search-files")).toContain("src/queue.ts");
      expect(getToolExecution(result, "search-ast").isError).toBe(false);
      expect(getToolResultText(result, "search-ast")).toContain("src/queue.ts:1");
      expect(getToolResultText(result, "search-ast")).toContain("legacyQueue");
    });
  }, 180_000);
});

async function runExplicitSearchReplacement(
  testName: string,
  sourceText: string,
  selector: string,
  expectedText: string,
): Promise<void> {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "anchors.txt");
    const firstLine = "legacyName = legacyName;";
    const secondLine = "legacyName alone";
    await writeFile(source, sourceText, "utf8");
    const matches = [
      searchMatchAt(source, 1, firstLine, "legacyName", 0),
      searchMatchAt(source, 1, firstLine, "legacyName", 1),
      searchMatchAt(source, 2, secondLine, "legacyName"),
    ];
    const searchId = createSearchSessionId("legacyName", matches, directory);
    const result = await new PiIntegrationTest({
      testName,
      cwd: directory,
      extensions: extensions.paths,
      tools: ["search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: `${testName}-search`,
              name: "search",
              arguments: { query: "legacyName" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: `${testName}-replace`,
              name: "replace",
              arguments: {
                start: selector.replace("SEARCH_SELECTOR", `SEARCH#${searchId}`),
                text: "UPDATED",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run(`Search legacyName and replace with ${selector}`);

    expect(getToolExecution(result, `${testName}-search`).isError).toBe(false);
    expect(getToolExecution(result, `${testName}-replace`).isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe(expectedText);
  });
}

async function runExplicitSearchDeletion(
  testName: string,
  sourceText: string,
  expectedText: string,
): Promise<void> {
  await withTempWorkspace(async (directory) => {
    const source = path.join(directory, "anchors.txt");
    const lines = sourceText.split(/\r?\n/u);
    const lineNumber = lines[0] === "legacyName first" ? 1 : 2;
    const lineText = lines[lineNumber - 1] ?? "";
    await writeFile(source, sourceText, "utf8");
    const matches = [searchMatch(source, lineNumber, lineText, "legacyName")];
    const searchId = createSearchSessionId("legacyName", matches, directory);
    const result = await new PiIntegrationTest({
      testName,
      cwd: directory,
      extensions: extensions.paths,
      tools: ["search", "delete"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: `${testName}-search`,
              name: "search",
              arguments: { query: "legacyName" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: `${testName}-delete`,
              name: "delete",
              arguments: { start: `SEARCH#${searchId}:1:line` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("done")]),
      ],
    }).run(`Search legacyName and delete its line anchor`);

    expect(getToolExecution(result, `${testName}-search`).isError).toBe(false);
    expect(getToolExecution(result, `${testName}-delete`).isError).toBe(false);
    await expect(readFile(source, "utf8")).resolves.toBe(expectedText);
  });
}

function searchMatch(
  source: string,
  lineNumber: number,
  lineText: string,
  matchedText: string,
): TextSearchMatch {
  return searchMatchAt(source, lineNumber, lineText, matchedText);
}

function searchMatchAt(
  source: string,
  lineNumber: number,
  lineText: string,
  matchedText: string,
  occurrence = 0,
): TextSearchMatch {
  let startColumn = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    startColumn = lineText.indexOf(matchedText, startColumn + 1);
    if (startColumn === -1) {
      throw new Error(
        `Missing occurrence ${String(occurrence + 1)} of ${matchedText} in ${lineText}`,
      );
    }
  }

  return {
    source,
    lineNumber,
    startColumn,
    endColumn: startColumn + matchedText.length,
    matchedText,
    lineText,
  };
}
async function readSessionArtifact(runFile: string): Promise<string> {
  const records = (await readFile(runFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly kind?: unknown; readonly data?: unknown });
  const session = records.find(({ kind, data }) => kind === "session" && typeof data === "string");

  if (typeof session?.data !== "string") {
    throw new Error("Expected the run artifact to contain a persisted session");
  }

  return session.data;
}

async function runInSeparatePi<T>(run: () => Promise<T>): Promise<T> {
  const runner = process.env.PI_INTEGRATION_TEST_RUNNER;
  delete process.env.PI_INTEGRATION_TEST_RUNNER;

  try {
    return await run();
  } finally {
    if (runner !== undefined) {
      process.env.PI_INTEGRATION_TEST_RUNNER = runner;
    }
  }
}
