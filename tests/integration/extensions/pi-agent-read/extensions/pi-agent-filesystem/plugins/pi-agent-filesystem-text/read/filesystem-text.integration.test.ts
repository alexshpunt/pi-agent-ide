import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    assistantMessage,
    getProviderSystemPrompt,
    getToolResultMessage,
    getToolResultText,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
]);
afterAll(() => generatedExtensions.dispose());
const tempRoot = path.resolve(".tmp/pi-agent-filesystem-text");
const textFixture = "first line\nsecond line\nthird line\n";

test("reads relative, absolute, empty, and ranged UTF-8 text when loaded before the provider", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const relative = path.join(directory, "notes.txt");
        const outside = path.join(directory, "outside.txt");
        const empty = path.join(directory, "empty.txt");
        const tail = path.join(directory, "tail.txt");
        await mkdir(path.join(directory, "workspace"));
        await writeFile(relative, textFixture, "utf8");
        await writeFile(outside, "absolute text\n", "utf8");
        await writeFile(empty, "", "utf8");
        await writeFile(tail, "one\ntwo\nthree\nfour\nfive", "utf8");

        expect(getToolResultText(
            await runRead(
                directory,
                "notes.txt",
                "filesystem-text-relative",
            ),
        )).toBe(textFixture);
        expect(getToolResultText(
            await runRead(
                path.join(directory, "workspace"),
                outside,
                "filesystem-text-absolute",
            ),
        )).toBe("absolute text\n");
        expect(getToolResultText(
            await runRead(
                directory,
                "empty.txt",
                "filesystem-text-empty",
            ),
        )).toBe("");
        expect(getToolResultText(
            await runRead(
                directory,
                "notes.txt",
                "filesystem-text-range",
                { offset: 2, limit: 1 },
            ),
        )).toContain("second line");
        expect(getToolResultText(
            await runRead(directory, "tail.txt", "filesystem-text-tail", { offset: -2 }),
        )).toBe("four\nfive");
        expect(getToolResultText(
            await runRead(directory, "tail.txt", "filesystem-text-tail-limit", { offset: -4, limit: 2 }),
        )).toContain("two\nthree");
    });
});

test("reads file URLs and lists directories as read-only resources", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const nested = path.join(directory, "nested");
        await mkdir(nested);
        await writeFile(path.join(directory, "notes.txt"), "hello\n", "utf8");
        await writeFile(path.join(nested, "child.txt"), "child\n", "utf8");

        expect(getToolResultText(
            await runRead(directory, directory, "filesystem-text-directory"),
        )).toBe([
            `📁 ${directory}/`,
            "",
            "  📁 nested",
            "  📄 notes.txt",
        ].join("\n"));

        expect(getToolResultText(
            await runRead(directory, pathToFileURL(path.join(directory, "notes.txt")).href, "filesystem-text-file-url"),
        )).toBe("hello\n");
    });
});

test("reports malformed bytes through the read contract", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        await writeFile(path.join(directory, "invalid.bin"), Buffer.from([0xc3, 0x28]));
        const result = await runRead(
            directory,
            "invalid.bin",
            "filesystem-text-invalid-utf8",
        );

        expect(getToolResultMessage(result, "read")).toMatchObject({
            details: { failure: { code: "READ_FAILED", resolverId: "filesystem" } },
        });
    });
});

test("advertises text through the filesystem read provider", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "filesystem-text-prompt",
            cwd: directory,
            extensions: generatedExtensions.paths,
            tools: ["read"],
            conversation: [assistantMessage([text("The prompt was inspected")])],
        }).run("Inspect installed filesystem content types");

        expect(getProviderSystemPrompt(result)).toContain([
            "# Read Extensions",
            "",
            "- `filesystem` — Reads local filesystem paths and file:// URLs. Directories are read-only listings.",
            "  - `text` — UTF-8 text.",
        ].join("\n"));
    });
});

async function runRead(
    cwd: string,
    source: string,
    testName: string,
    range: { readonly offset?: number; readonly limit?: number; } = {},
)
{
    return new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd,
        extensions: generatedExtensions.paths,
        tools: ["read"],
        conversation: [
            assistantMessage([
                toolCall({ id: "read", name: "read", arguments: { path: source, ...range } }),
            ], { stopReason: "toolUse" }),
            assistantMessage([text("The read call finished")]),
        ],
    }).run(`Read ${source}`);
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void>
{
    await mkdir(tempRoot, { recursive: true });
    const directory = await mkdtemp(path.join(tempRoot, "filesystem-text-"));

    try
    {
        await callback(directory);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}
