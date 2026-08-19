import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getProviderSystemPrompt,
    getToolResultMessage,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
]);
afterAll(() => generatedExtensions.dispose());
const tempRoot = path.resolve(".tmp/pi-agent-filesystem-image");
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");

test("delivers native image content from bytes when loaded before the provider", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const source = "misleading-name.txt";
        await writeFile(path.join(directory, source), png);

        const result = await runRead(directory, source, "filesystem-image");
        expect(getToolResultMessage(result, "read")).toMatchObject({
            isError: false,
            content: [
                { type: "text", text: "Read image [image/png]" },
                { type: "image", data: pngBase64, mimeType: "image/png" },
            ],
        });

        const ranged = await runRead(
            directory,
            source,
            "filesystem-image-range",
            { offset: 1 },
        );
        expect(getToolResultMessage(ranged, "read")).toMatchObject({
            details: { failure: { code: "UNSUPPORTED_RANGE", resolverId: "filesystem" } },
        });
    });
});

test("advertises images through the filesystem read provider", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "filesystem-image-prompt",
            cwd: directory,
            extensions: generatedExtensions.paths,
            tools: ["read"],
            conversation: [assistantMessage([text("The prompt was inspected")])],
        }).run("Inspect installed filesystem content types");

        expect(getProviderSystemPrompt(result)).toContain([
            "# Read Extensions",
            "",
            "- `filesystem` — Reads local filesystem paths and file:// URLs. Directories are read-only listings.",
            "  - `image` — JPEG, static PNG, GIF, WebP, and BMP images.",
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
    const directory = await mkdtemp(path.join(tempRoot, "filesystem-image-"));

    try
    {
        await callback(directory);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}
