import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getToolResultMessage,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "#tests/integration/test-stand/generate-read-extensions.js";

const generatedExtensions = await generateReadExtensions();
afterAll(() => generatedExtensions.dispose());
const generatedTempExtensions = await generateReadExtensions([
    "agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/tests/integration/test-stand/temp-resource-fixture-extension.ts",
]);
afterAll(() => generatedTempExtensions.dispose());
const tempRoot = path.resolve(".tmp");

test("registers read without a resolver", async () =>
{
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-core-"));

    try
    {
        await writeFile(path.join(cwd, "fixture.txt"), "core fixture\n", "utf8");
        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "read-without-resolver",
            cwd,
            extensions: generatedExtensions.paths,
            tools: ["read"],
            conversation: [
                assistantMessage([
                    toolCall({ id: "read", name: "read", arguments: { path: "fixture.txt" } }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("The read call finished")]),
            ],
        }).run("Run read without a resolver");
        const message = getToolResultMessage(result, "read");

        expect(message).toMatchObject({
            toolName: "read",
            details: {
                failure: {
                    code: "NO_RESOLVER",
                    source: "fixture.txt",
                },
            },
        });
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("reads a saved temporary result through real Pi", async () =>
{
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-temp-protocol-"));

    try
    {
        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "read-temp-protocol",
            cwd,
            extensions: generatedTempExtensions.paths,
            tools: ["read"],
            conversation: [
                assistantMessage([
                    toolCall({ id: "create-temp", name: "read", arguments: { path: "dynamic:large-fixture" } }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "read-temp",
                        name: "read",
                        arguments: { path: "temp:fixture-latest", offset: 2_001 },
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Read the large dynamic fixture");
        const message = getToolResultMessage(result, "create-temp");
        const block = message.content[0];

        expect(block).toMatchObject({ type: "text", text: expect.stringContaining("Full output: temp:") });
        expect(message.details).toMatchObject({
            resolvedBy: "temp-resource-fixture",
            temporarySource: expect.stringMatching(/^temp:[0-9a-f-]+$/u),
        });
        expect(getToolResultMessage(result, "read-temp")).toMatchObject({
            content: [{ type: "text", text: "fixture line 2001" }],
            details: { resolvedBy: "temp", startLine: 2_001, endLine: 2_001 },
        });
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
});
