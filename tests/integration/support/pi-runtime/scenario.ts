import { diffLines } from "diff";
import { expect } from "vitest";

import {
    assistantMessage,
    getToolExecution,
    getToolExecutionDetails,
    getToolResultText,
    PiIntegrationTest,
    type PiIntegrationTestResult,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";

interface TextToolScenario
{
    readonly extensions: readonly string[];
    readonly cwd: string;
    readonly testName: string;
    readonly tool: "write" | "insert" | "replace" | "delete" | "copy" | "move";
    readonly tools?: readonly string[];
    readonly arguments: Record<string, unknown>;
}

export interface TextToolScenarioResult
{
    readonly result: PiIntegrationTestResult;
    readonly mutationCallId: string;
    readonly preflightCallIds: readonly string[];
    readonly postflightCallIds: readonly string[];
}

export async function runTextToolScenario(scenario: TextToolScenario): Promise<TextToolScenarioResult>
{
    const testPath = expect.getState().testPath;

    if (testPath === undefined)
    {
        throw new Error("Cannot determine the current integration test file");
    }

    const files = editedFiles(scenario.arguments);
    const preflightCallIds = files.map((_file, index) => `${scenario.testName}-read-before-${index}`);
    const postflightCallIds = files.map((_file, index) => `${scenario.testName}-read-after-${index}`);
    const mutationCallId = `${scenario.testName}-${scenario.tool}`;
    const conversation = [
        ...files.map((file, index) => readMessage(preflightCallIds[index]!, file)),
        assistantMessage([
            toolCall({ id: mutationCallId, name: scenario.tool, arguments: scenario.arguments }),
        ], { stopReason: "toolUse" }),
        ...files.map((file, index) => readMessage(postflightCallIds[index]!, file)),
        assistantMessage([text(`The ${scenario.tool} operation finished`)]),
    ];
    const result = await new PiIntegrationTest({
        testName: scenario.testName,
        cwd: scenario.cwd,
        extensions: scenario.extensions,
        tools: scenario.tools ?? [scenario.tool, "read"],
        conversation,
        artifactsDir: testArtifactsDir(testPath),
    }).run(`Run one ${scenario.tool} operation`);

    for (const callId of [...preflightCallIds, ...postflightCallIds])
    {
        expect(getToolExecution(result, callId).isError, callId).toBe(false);
    }

    return { result, mutationCallId, preflightCallIds, postflightCallIds };
}

export function expectTextToolDiff(
    scenario: TextToolScenarioResult,
    path: string,
    before: string,
    after: string,
): void
{
    const expected = expectedDiff(before, after);
    const output = getToolResultText(scenario.result, scenario.mutationCallId);
    const lines = output.split("\n");

    expect(lines[0]).toBe(`${path} +${expected.added.length} -${expected.removed.length}`);
    expect(lines.slice(1).some((line) => /^[+ -]\|/u.test(line))).toBe(true);

    for (const line of expected.added.filter((value) => value.length > 0))
    {
        expect(lines.some((rendered) => rendered.startsWith("+|") && rendered.includes(line))).toBe(true);
    }

    for (const line of expected.removed.filter((value) => value.length > 0))
    {
        expect(lines.some((rendered) => rendered.startsWith("-|") && rendered.endsWith(line))).toBe(true);
    }

    const details = getToolExecutionDetails(getToolExecution(scenario.result, scenario.mutationCallId));
    const data = getTextToolMutationData(details);
    expect(data).toMatchObject({
        addedLines: expected.added.length,
        removedLines: expected.removed.length,
        beforeContentMap: { [path]: before },
        afterContent: after,
    });
    expect(Array.isArray(data.diffs) && data.diffs.length > 0).toBe(true);
}

function expectedDiff(before: string, after: string): { readonly added: string[]; readonly removed: string[]; }
{
    const added: string[] = [];
    const removed: string[] = [];

    for (const part of diffLines(before, after))
    {
        const values = part.value.replaceAll("\r\n", "\n").split("\n");

        if (values.at(-1) === "")
        {
            values.pop();
        }

        if (part.added)
        {
            added.push(...values);
        }
        else if (part.removed)
        {
            removed.push(...values);
        }
    }

    return { added, removed };
}

export function getTextToolMutationData(details: unknown): Record<string, unknown>
{
    if (typeof details !== "object" || details === null)
    {
        throw new TypeError("Text tool result has no structured details");
    }

    const results = (details as { readonly results?: unknown; }).results;
    const first: unknown = Array.isArray(results) ? (results as readonly unknown[])[0] : undefined;

    if (typeof first !== "object" || first === null)
    {
        throw new TypeError("Text tool result has no mutation result");
    }

    const data = (first as { readonly data?: unknown; }).data;

    if (typeof data !== "object" || data === null)
    {
        throw new TypeError("Text tool result has no mutation data");
    }

    return data as Record<string, unknown>;
}

function editedFiles(arguments_: Record<string, unknown>): readonly string[]
{
    const files = new Set<string>();

    for (const key of ["path", "target"])
    {
        const value = arguments_[key];

        if (typeof value === "string" && value.length > 0)
        {
            files.add(value);
        }
    }

    return [...files];
}

function readMessage(id: string, file: string)
{
    return assistantMessage([
        toolCall({ id, name: "read", arguments: { path: file, offset: 1 } }),
    ], { stopReason: "toolUse" });
}
