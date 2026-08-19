import { readFile } from "node:fs/promises";
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
import { describe, expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extension = path.join(
    process.cwd(),
    "tests/integration/extensions/pi-agent-text-editor/core/tool-call-interceptor/register-extension.ts",
);

function call(name: string, id: string, arguments_: Record<string, unknown>)
{
    return toolCall({ id, name, arguments: arguments_ });
}

async function runTest(
    directory: string,
    testName: string,
    tools: string[],
    calls: ReturnType<typeof toolCall>[],
)
{
    const run = new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd: directory,
        extensions: [extension],
        tools,
        conversation: [
            assistantMessage(calls, { stopReason: "toolUse" }),
            assistantMessage([text("done")]),
        ],
    });
    return run.run("Exercise the tool interceptor fixture");
}

describe("pi-agent-text-editor tool-call interceptor", () =>
{
    test("blocks from partial streamed arguments", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const result = await runTest(directory, "interceptor-partial", ["intercept_partial"], [
                call("intercept_partial", "partial-call", { value: "streamed" }),
            ]);

            expect(getToolExecution(result, "partial-call").isError).toBe(true);
            expect(getToolResultText(result, "partial-call")).toContain("partial:streamed");
        });
    });

    test("keeps registration order, replaces in place, and stops after a block", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const result = await runTest(directory, "interceptor-order", ["intercept_order"], [
                call("intercept_order", "order-call", { value: "run" }),
            ]);

            expect(getToolResultText(result, "order-call")).toContain("replaced-first,second");
            expect(getToolResultText(result, "order-call")).not.toContain("third-must-not-run");
        });
    });

    test("substitutes the real tool result with the blocked result", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const result = await runTest(directory, "interceptor-result", ["intercept_result"], [
                call("intercept_result", "result-call", { value: "run" }),
            ]);

            expect(getToolExecution(result, "result-call").isError).toBe(true);
            expect(getToolResultText(result, "result-call")).toContain("substituted-result");
            expect(getToolResultText(result, "result-call")).not.toContain("executed");
        });
    });

    test("runs abort cleanup before the next streamed call", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const result = await new PiIntegrationTest({
                artifactsDir: testArtifactsDir(expect.getState().testPath),
                testName: "interceptor-abort-cleanup",
                cwd: directory,
                extensions: [extension],
                tools: ["intercept_abort_cleanup"],
                conversation: [
                    assistantMessage([
                        toolCall({
                            id: "abort-cleanup-first",
                            name: "intercept_abort_cleanup",
                            argumentsJson: "{\"block\":true,\"value\":\"first\"}",
                            chunks: {
                                kind: "explicit",
                                chunks: ["{\"block\":true,", "\"value\":\"first\"}"],
                            },
                            delayMs: 10,
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: "abort-cleanup-verify",
                            name: "intercept_abort_cleanup",
                            arguments: { value: "verify" },
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("done")]),
                ],
            }).run("Verify abort cleanup");

            expect(getToolResultText(result, "abort-cleanup-first")).toContain("abort-cleanup-first-block");
            expect(getToolResultText(result, "abort-cleanup-verify")).toContain("abort-cleanup-observed");
            expect(getToolResultText(result, "abort-cleanup-verify")).not.toContain("abort-cleanup-missing");
        });
    });
    test("recovers complete calls before a blocked streamed call", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            await runTest(directory, "interceptor-recovery", ["intercept_recovery"], [
                call("intercept_recovery", "recovery-blocked", {
                    entries: [{ value: "keep" }],
                }),
            ]);

            await expect(readFile(path.join(directory, "recovered.json"), "utf8"))
                .resolves.toBe("{\"values\":[\"keep\"]}");
        });
    });
});
