import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
    "src/plugins/pi-agent-ide-ast/index.ts",
    "src/plugins/pi-agent-ide-lsp/index.ts",
    "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
]);
const productionSource = path.resolve("src/code-view/reference.ts");
const tempRoot = path.resolve(".tmp/pi-agent-code-view-demo");
const interactivePacing = process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 256 }, delayMs: 0 };

afterAll(async () =>
{
    await generatedExtensions.dispose();
    await rm(tempRoot, { recursive: true, force: true });
});

test("shows every read code-view protocol on a production TypeScript file", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const fileName = "reference.ts";
        await writeTypeScriptProject(directory, fileName, await readFile(productionSource, "utf8"));

        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "interactive-demo-read-code-views",
            cwd: directory,
            extensions: generatedExtensions.paths,
            tools: ["read"],
            rawMode: false,
            timeoutMs: 180_000,
            conversation: [
                assistantMessage([
                    toolCall({
                        id: "demo-read-ast",
                        name: "read",
                        arguments: { path: `ast:${fileName}` },
                        ...interactivePacing,
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "demo-read-symbol",
                        name: "read",
                        arguments: { path: `symbol:${fileName}#parseCodeViewReference` },
                        ...interactivePacing,
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "demo-read-symbol-graph",
                        name: "read",
                        arguments: { path: `graph:${fileName}#parseCodeViewReference` },
                        ...interactivePacing,
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "demo-read-file-graph",
                        name: "read",
                        arguments: { path: `graph:${fileName}` },
                        ...interactivePacing,
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("All read code-view protocols finished")]),
            ],
        }).run("Show AST, symbol, symbol graph, and file graph views for a production source file");

        const ast = getToolResultText(result, "demo-read-ast");
        expect(ast).toContain("export function parseCodeViewReference");
        expect(ast).toMatch(/\d+#[A-F0-9]{4}\|export function parseCodeViewReference/u);
        expect(ast).not.toContain("const value = source.slice");

        const symbol = getToolResultText(result, "demo-read-symbol");
        expect(symbol).toContain("## symbol: parseCodeViewReference");
        expect(symbol).toContain("const value = source.slice");
        expect(symbol).toMatch(/\d+#[A-F0-9]{4}\|\s*const value = source\.slice/u);

        const symbolGraph = getToolResultText(result, "demo-read-symbol-graph");
        expect(symbolGraph).toContain("## graph: parseCodeViewReference");
        expect(symbolGraph).toContain("Outgoing calls:");
        expect(symbolGraph).toContain("decodePart");

        const fileGraph = getToolResultText(result, "demo-read-file-graph");
        expect(fileGraph).toContain("## file graph: reference.ts");
        expect(fileGraph).toContain("### Function parseCodeViewReference");
        expect(fileGraph).toContain("### Function formatCodeViewReference");
    });
}, 180_000);

async function writeTypeScriptProject(directory: string, fileName: string, source: string): Promise<void>
{
    await writeFile(
        path.join(directory, "lsp-servers.json"),
        JSON.stringify({
            servers: {
                "typescript-language-server": {
                    command: [path.join(process.cwd(), "node_modules/typescript-7/bin/tsc"), "--lsp", "--stdio"],
                    rootMarkers: ["tsconfig.json"],
                    languages: { typescript: { extensions: [".ts"] } },
                    capabilities: ["diagnostics"],
                },
            },
        }),
        "utf8",
    );
    await writeFile(
        path.join(directory, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: [fileName] }),
        "utf8",
    );
    await writeFile(path.join(directory, fileName), source, "utf8");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void>
{
    await mkdir(tempRoot, { recursive: true });
    const directory = await mkdtemp(path.join(tempRoot, "project-"));

    try
    {
        await callback(directory);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}
