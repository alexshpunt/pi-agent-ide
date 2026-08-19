import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const argumentOrderExtension = path.join(
    process.cwd(),
    "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-argument-order/index.ts",
);

afterAll(() => extensions.dispose());

interface ToolCase
{
    readonly name: string;
    readonly initial: string;
    readonly arguments: Record<string, unknown>;
    readonly expected: string;
}

const cases: readonly ToolCase[] = [
    { name: "write", initial: "original", arguments: { path: "subject.txt", content: "written" }, expected: "written" },
    {
        name: "replace",
        initial: "alpha\nbeta",
        arguments: { path: "subject.txt", start: "begin", text: "replaced" },
        expected: "replaced\nbeta",
    },
    {
        name: "insert",
        initial: "alpha\nbeta",
        arguments: { path: "subject.txt", anchor: "begin", text: "inserted" },
        expected: "alpha\ninserted\nbeta",
    },
    {
        name: "delete",
        initial: "alpha\nbeta",
        arguments: { path: "subject.txt", start: "begin" },
        expected: "beta",
    },
    {
        name: "copy",
        initial: "alpha\nbeta",
        arguments: { path: "subject.txt", start: "begin", targetStart: "end" },
        expected: "alpha\nbeta\nalpha",
    },
    {
        name: "move",
        initial: "alpha\nbeta",
        arguments: { path: "subject.txt", start: "begin", targetStart: "end" },
        expected: "beta\nalpha",
    },
];

async function runCall(
    directory: string,
    testName: string,
    toolName: string,
    callId: string,
    arguments_: Record<string, unknown>,
)
{
    return new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd: directory,
        extensions: [...extensions.paths, argumentOrderExtension],
        tools: [toolName],
        conversation: [
            assistantMessage([toolCall({ id: callId, name: toolName, arguments: arguments_ })], {
                stopReason: "toolUse",
            }),
            assistantMessage([text("done")]),
        ],
    }).run(`Call ${toolName}`);
}

describe("pi-agent-text-editor argument order", () =>
{
    for (const toolCase of cases)
    {
        test(`${toolCase.name} accepts schema order and blocks reversed order`, async () =>
        {
            await withTempWorkspace(async (directory) =>
            {
                const file = path.join(directory, "subject.txt");
                await writeFile(file, toolCase.initial, "utf8");
                const validId = `${toolCase.name}-valid`;
                const valid = await runCall(
                    directory,
                    `argument-order-${toolCase.name}-valid`,
                    toolCase.name,
                    validId,
                    toolCase.arguments,
                );

                expect(getToolExecution(valid, validId).isError).toBe(false);
                await expect(readFile(file, "utf8")).resolves.toBe(toolCase.expected);
            });

            await withTempWorkspace(async (directory) =>
            {
                const file = path.join(directory, "subject.txt");
                await writeFile(file, toolCase.initial, "utf8");
                const reversedArguments = Object.fromEntries(Object.entries(toolCase.arguments).reverse());
                const invalidId = `${toolCase.name}-invalid`;
                const invalid = await runCall(
                    directory,
                    `argument-order-${toolCase.name}-invalid`,
                    toolCase.name,
                    invalidId,
                    reversedArguments,
                );

                expect(getToolExecution(invalid, invalidId).isError).toBe(true);
                expect(getToolResultText(invalid, invalidId)).toContain(
                    `${toolCase.name} blocked: argument order violation`,
                );
                expect(getToolResultText(invalid, invalidId)).toContain(
                    "Call " + toolCase.name + " again with arguments in schema order.",
                );
                await expect(readFile(file, "utf8")).resolves.toBe(toolCase.initial);
            });
        });
    }
});
