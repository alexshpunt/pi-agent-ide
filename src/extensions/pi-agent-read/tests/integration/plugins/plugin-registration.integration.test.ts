import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import {
    ASYNC_CORE_FIRST_SOURCE,
    ASYNC_PLUGIN_FIRST_SOURCE,
    ASYNC_RESOLVER_TEXT,
    generatePluginRegistrationExtensions,
    SYNC_RESOLVER_SOURCE,
    SYNC_RESOLVER_TEXT,
} from "#tests/integration/test-stand/generate-plugin-registration-extensions.js";

const generatedExtensions = await generatePluginRegistrationExtensions();
afterAll(() => generatedExtensions.dispose());
const tempRoot = path.resolve(".tmp");

test("waits for asynchronous plugin setup before the first tool call", async () =>
{
    await withTempDirectory(async (cwd) =>
    {
        const coreFirst = await runRead(cwd, ASYNC_CORE_FIRST_SOURCE, "asynchronous-plugin-core-first");
        const pluginFirst = await runRead(cwd, ASYNC_PLUGIN_FIRST_SOURCE, "asynchronous-plugin-plugin-first");

        expect([
            getToolResultText(coreFirst),
            getToolResultText(pluginFirst),
        ]).toEqual([ASYNC_RESOLVER_TEXT, ASYNC_RESOLVER_TEXT]);
    });
});

test("registers contributions from synchronous plugin setup", async () =>
{
    await withTempDirectory(async (cwd) =>
    {
        const result = await runRead(cwd, SYNC_RESOLVER_SOURCE, "synchronous-plugin-registration");

        expect(getToolResultText(result)).toBe(SYNC_RESOLVER_TEXT);
    });
});

async function runRead(cwd: string, source: string, testName: string)
{
    return new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd,
        extensions: generatedExtensions.paths,
        tools: ["read"],
        conversation: [
            assistantMessage([
                toolCall({ id: "read", name: "read", arguments: { path: source } }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The registration test finished")]),
        ],
    }).run("Read through the registered plugin resolver");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void>
{
    await mkdir(tempRoot, { recursive: true });
    const directory = await mkdtemp(path.join(tempRoot, "pi-agent-read-plugin-registration-cwd-"));

    try
    {
        await callback(directory);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}
