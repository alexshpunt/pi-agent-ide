import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import {
    assistantMessage,
    getToolExecution,
    getToolResultText,
    PiIntegrationTest,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const runFile = promisify(execFile);
const extensions = createExtensionSet();
const defaultTextEditorExtension =
    path.resolve("tests/integration/extensions/pi-agent-text-editor/register-extension.ts");
const rendererTestStand =
    path.resolve("tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts");
const undoExtension = path.resolve("src/plugins/pi-agent-ide-changes/index.ts");
const demoFileName = "scheduler-selective-undo-demo.ts";
const interactivePacing = process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 512 }, delayMs: 0 };

const baseline = buildSchedulerSource(8, "eu-central", "stable");
const current = buildSchedulerSource(24, "eu-west", "warming");
const restored = current.replace("const MAX_PARALLEL_JOBS = 24;", "const MAX_PARALLEL_JOBS = 8;");

interface GitCommandError
{
    readonly stderr?: string;
}

afterAll(() => extensions.dispose());

describe("interactive text editor demos", () =>
{
    test("shows selective undo through the standard mutation diff", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const file = path.join(directory, demoFileName);
            await initializeRepository(directory, file);
            const selector = selectorForMarker("const MAX_PARALLEL_JOBS = 24;");
            const readCallId = "demo-selective-undo-read";
            const undoCallId = "demo-selective-undo";
            const result = await new PiIntegrationTest({
                testName: "interactive-demo-selective-undo",
                cwd: directory,
                extensions: [
                    ...extensions.paths.map((extension) =>
                        extension === defaultTextEditorExtension ? rendererTestStand : extension
                    ),
                    undoExtension,
                ],
                tools: ["read", "undo"],
                rawMode: false,
                timeoutMs: 180_000,
                conversation: [
                    assistantMessage([
                        toolCall({
                            id: readCallId,
                            name: "read",
                            arguments: { path: demoFileName },
                            ...interactivePacing,
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([
                        toolCall({
                            id: undoCallId,
                            name: "undo",
                            arguments: { file: demoFileName, change: selector },
                            ...interactivePacing,
                        }),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("The selective undo demo is complete", { delayMs: 0 })]),
                ],
            }).run("Read the current changes, then undo only the parallel jobs change");

            expect(getToolResultText(result, readCallId)).toContain(selector);
            expect(getToolExecution(result, undoCallId).isError).toBe(false);
            await expect(readFile(file, "utf8")).resolves.toBe(restored);

            const header = `undo ${demoFileName}:${selector} +0 ~1 -0`;
            const panel = mutationPanel(result.tuiRenderedOutput, header);
            const line = lineNumber(current, "const MAX_PARALLEL_JOBS = 24;");
            expect(panel).toMatch(new RegExp(`${line}\\s+~\\s+const MAX_PARALLEL_JOBS = 8;`, "u"));
            expect(panel).not.toContain("const MAX_PARALLEL_JOBS = 24;");
        });
    }, 180_000);
});

async function initializeRepository(directory: string, file: string): Promise<void>
{
    await runGit(directory, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(file, baseline, "utf8");
    await runGit(directory, ["add", demoFileName]);
    await runGit(directory, [
        "-c",
        "user.name=Pi Integration",
        "-c",
        "user.email=pi-integration@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
    ]);
    await writeFile(file, current, "utf8");
}

async function runGit(directory: string, arguments_: readonly string[]): Promise<void>
{
    try
    {
        await runFile("git", arguments_, { cwd: directory });
    }
    catch (error)
    {
        const commandError = error as GitCommandError;
        throw new Error(commandError.stderr ?? String(error));
    }
}

function selectorForMarker(marker: string): string
{
    const group = createChangeGroups(demoFileName, baseline, baseline, current).find((candidate) =>
        candidate.segments.some((segment) => segment.worktreeText.includes(marker))
    );

    if (group === undefined)
    {
        throw new Error(`No undo change contains ${marker}`);
    }

    return group.selector;
}

function mutationPanel(rendered: string, header: string): string
{
    const panelStart = rendered.indexOf("╭─", rendered.indexOf(header));
    const panelEnd = rendered.indexOf("╯", panelStart);

    if (panelStart === -1 || panelEnd === -1)
    {
        throw new Error(`No mutation panel follows ${header}`);
    }

    return rendered.slice(panelStart, panelEnd + 1);
}

function lineNumber(content: string, marker: string): number
{
    const index = content.indexOf(marker);

    if (index === -1)
    {
        throw new Error(`Missing demo marker ${marker}`);
    }

    return content.slice(0, index).split("\n").length;
}

function buildSchedulerSource(maxParallelJobs: number, region: string, status: string): string
{
    const queues = Array.from({ length: 80 }, (_, index) =>
    {
        const number = String(index + 1).padStart(2, "0");
        return `    { name: "worker-${number}", queue: "jobs-${number}", concurrency: ${index % 6 + 1} },`;
    });

    return [
        "export interface WorkerQueue",
        "{",
        "    readonly name: string;",
        "    readonly queue: string;",
        "    readonly concurrency: number;",
        "}",
        "",
        `const MAX_PARALLEL_JOBS = ${maxParallelJobs};`,
        "const DEFAULT_RETRY_LIMIT = 4;",
        "",
        "export const workerQueues = [",
        ...queues,
        "] as const satisfies readonly WorkerQueue[];",
        "",
        `export const DEFAULT_REGION = "${region}";`,
        "",
        "export function schedulerSummary(): string",
        "{",
        `    return \`${status}: \${workerQueues.length} queues in \${DEFAULT_REGION}, max=\${MAX_PARALLEL_JOBS}\`;`,
        "}",
        "",
    ].join("\n");
}
