import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getToolExecution,
    getToolResultMessage,
    PiIntegrationTest,
    testArtifactsDir,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const repoRoot = path.resolve();
const extensionRoot = repoRoot;
const extensions = [
    path.join(extensionRoot, "src/extensions/pi-agent-read/index.ts"),
    path.join(extensionRoot, "src/extensions/pi-agent-text-editor/index.ts"),
    path.join(extensionRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
    path.join(
        extensionRoot,
        "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
    ),
    path.join(extensionRoot, "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.ts"),
    path.join(extensionRoot, "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts"),
    path.join(extensionRoot, "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts"),
];
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-text-editor");

test("inherits the last resolved resource in a later edit call", async () =>
{
    await mkdir(tempRoot, { recursive: true });
    const cwd = await mkdtemp(path.join(tempRoot, "resolved-resource-inheritance-"));
    const file = path.join(cwd, "fixture.txt");

    try
    {
        await writeFile(file, "alpha\nbeta\n", "utf8");
        const result = await new PiIntegrationTest({
            artifactsDir: testArtifactsDir(expect.getState().testPath),
            testName: "resolved-resource-inheritance",
            cwd,
            extensions,
            tools: ["read", "replace"],
            conversation: [
                assistantMessage([
                    toolCall({ id: "read-file", name: "read", arguments: { path: "fixture.txt" } }),
                ], { stopReason: "toolUse" }),
                assistantMessage([
                    toolCall({
                        id: "replace-line",
                        name: "replace",
                        arguments: { start: "1#BE76", text: "changed" },
                    }),
                ], { stopReason: "toolUse" }),
                assistantMessage([text("Done")]),
            ],
        }).run("Read the fixture, then replace its first line without repeating the path");

        expect(getToolResultMessage(result, "read-file").details).toMatchObject({
            source: file,
            resolvedBy: "filesystem",
        });
        expect(getToolExecution(result, "replace-line").isError).not.toBe(true);
        expect(await readFile(file, "utf8")).toBe("changed\nbeta\n");
    }
    finally
    {
        await rm(cwd, { recursive: true, force: true });
    }
});
