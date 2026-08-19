import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

const extensions = createExtensionSet();

afterAll(() => extensions.dispose());

describe("pi-agent-text-editor search", () =>
{
    test("previews exact regex matches and replaces the complete search across files", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
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
                searchMatch(first, 1, firstText.split("\n")[0]!, "legacyName"),
                searchMatch(first, 2, firstText.split("\n")[1]!, "LEGACYVALUE"),
                searchMatch(second, 1, secondText.trimEnd(), "legacyName"),
            ];
            const searchId = createSearchSessionId(query, matches, directory);
            const allAnchor = `SEARCH#${searchId}:all`;
            const searchCallId = "search-regex-preview";
            const replaceCallId = "replace-search-all";
            const result = await new PiIntegrationTest({
                testName: "text-editor-search-replace-all",
                cwd: directory,
                extensions: extensions.paths,
                tools: ["search", "replace"],
                rawMode: false,
                conversation: [
                    assistantMessage([
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
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: replaceCallId,
                            name: "replace",
                            arguments: { start: allAnchor, text: "modernName" },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("done")]),
                ],
            }).run("Find the legacy names, preview them, then replace every exact result");

            const searchOutput = getToolResultText(result, searchCallId);
            expect(getToolExecution(result, searchCallId).isError).toBe(false);
            expect(searchOutput).toContain(`${allAnchor} — 3 matches in 2 files`);
            expect(searchOutput).toContain(`SEARCH#${searchId}:1`);
            expect(searchOutput).toContain("⟦legacyName⟧");
            expect(searchOutput).toContain("⟦LEGACYVALUE⟧");
            expect(searchOutput).not.toContain("legacyNameExtra");
            expect(searchOutput).not.toContain("ignored.ts");
            expect(searchOutput).not.toContain("notes.md");
            const replaceExecution = getToolExecution(result, replaceCallId);
            expect(replaceExecution.isError).toBe(false);
            expect((getToolExecutionDetails(replaceExecution) as { results?: readonly unknown[]; }).results)
                .toHaveLength(2);
            await expect(readFile(first, "utf8")).resolves.toBe(
                firstText.replace("legacyName", "modernName").replace("LEGACYVALUE", "modernName"),
            );
            await expect(readFile(second, "utf8")).resolves.toBe("export const selected = modernName;\n");
            await expect(readFile(ignored, "utf8")).resolves.toBe("legacyName\n");
            await expect(readFile(markdown, "utf8")).resolves.toBe("legacyName\n");
        });
    }, 180_000);

    test("rejects the complete search before writing when one matched file changed", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
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
            const allAnchor = `SEARCH#${searchId}:all`;
            const changedFirst = "changed outside the search snapshot\nlegacyName in first\n";
            const result = await new PiIntegrationTest({
                testName: "text-editor-search-stale-all",
                cwd: directory,
                extensions: extensions.paths,
                tools: ["search", "write", "replace"],
                conversation: [
                    assistantMessage([
                        toolCall({ id: "search-before-change", name: "search", arguments: { query: "legacyName" } }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: "change-matched-file",
                            name: "write",
                            arguments: { path: "first.txt", content: changedFirst },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: "replace-stale-search",
                            name: "replace",
                            arguments: { start: allAnchor, text: "modernName" },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("done")]),
                ],
            }).run("Search, change one matched file, then try the old complete search anchor");

            expect(getToolResultText(result, "search-before-change")).toContain(allAnchor);
            expect(getToolResultText(result, "replace-stale-search")).toContain("search anchor is stale");
            await expect(readFile(first, "utf8")).resolves.toBe(changedFirst);
            await expect(readFile(second, "utf8")).resolves.toBe(secondText);
        });
    }, 180_000);

    test("restores the search result panel from the persisted session", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const source = path.join(directory, "src", "persisted.ts");
            await mkdir(path.dirname(source), { recursive: true });
            await writeFile(
                source,
                [
                    "export const legacyName = \"first\";",
                    "export const selected = legacyName;",
                    "",
                ].join("\n"),
                "utf8",
            );
            const firstRun = await new PiIntegrationTest({
                testName: "text-editor-search-renderer-persisted",
                cwd: directory,
                extensions: extensions.paths,
                tools: ["search"],
                rawMode: false,
                conversation: [
                    assistantMessage([
                        toolCall({ id: "persisted-search", name: "search", arguments: { query: "legacyName" } }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("Search complete")]),
                ],
            }).run("Find every legacy name");
            const sessionName = (await readdir(firstRun.artifacts.sessionDirectory)).find((entry) =>
                entry.endsWith(".jsonl")
            );

            if (sessionName === undefined)
            {
                throw new Error("Expected the search run to persist a session");
            }

            const sessionFile = path.join(firstRun.artifacts.sessionDirectory, sessionName);
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
                }).run("Continue after restoring the search session")
            );
            const rendered = resumed.tuiRenderedOutput;
            const searchView = rendered.slice(rendered.indexOf("search \"legacyName\""));

            expect(searchView).toContain("2 matches in 1 file");
            expect(searchView).toMatch(/src\/persisted\.ts\s+2/u);
            expect(searchView).toContain("export const legacyName");
            expect(searchView).toContain("export const selected = legacyName");
            expect(searchView).toContain("╭");
            expect(searchView).not.toContain("SEARCH#");
            expect(searchView).not.toContain("⟦");
        });
    }, 180_000);

    test("routes files and AST protocols through their installed resolvers", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const source = path.join(directory, "src", "queue.ts");
            await mkdir(path.dirname(source), { recursive: true });
            await writeFile(source, "export const legacyQueue = { name: \"jobs\" };\n", "utf8");
            const result = await new PiIntegrationTest({
                testName: "search-protocol-routing",
                cwd: directory,
                extensions: extensions.paths,
                tools: ["search"],
                conversation: [
                    assistantMessage([
                        toolCall({
                            id: "search-files",
                            name: "search",
                            arguments: { query: "files:queue", path: "src" },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: "search-ast",
                            name: "search",
                            arguments: { query: "ast:legacyQueue", path: "src" },
                        }),
                    ], { stopReason: "toolUse" }),
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

function searchMatch(source: string, lineNumber: number, lineText: string, matchedText: string): TextSearchMatch
{
    const startColumn = lineText.indexOf(matchedText);

    if (startColumn === -1)
    {
        throw new Error(`Missing ${matchedText} in ${lineText}`);
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

async function runInSeparatePi<T>(run: () => Promise<T>): Promise<T>
{
    const runner = process.env.PI_INTEGRATION_TEST_RUNNER;
    delete process.env.PI_INTEGRATION_TEST_RUNNER;

    try
    {
        return await run();
    }
    finally
    {
        if (runner !== undefined)
        {
            process.env.PI_INTEGRATION_TEST_RUNNER = runner;
        }
    }
}
