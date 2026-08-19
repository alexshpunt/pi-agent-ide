import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { runTextToolScenario } from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();

describe("pi-agent-text-editor copy", () =>
{
    test("copies a selected range from the source file into a different target file", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const source = await createFixture(directory, "source.txt", "source-one\ncopy-me\nsource-end\n");
            const target = await createFixture(directory, "target.txt", "target-start\ntarget-end\n");
            const sourcePath = path.relative(directory, source);
            const targetPath = path.relative(directory, target);
            const scenario = await runTextToolScenario({
                extensions: extensions.paths,
                cwd: directory,
                testName: "text-editor-copy-cross-file",
                tool: "copy",
                arguments: {
                    path: sourcePath,
                    start: formatLineHashAnchor(2, "copy-me"),
                    target: targetPath,
                    targetStart: formatLineHashAnchor(1, "target-start"),
                },
            });

            expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
            await expect(readFile(source, "utf8")).resolves.toBe("source-one\ncopy-me\nsource-end\n");
            await expect(readFile(target, "utf8")).resolves.toBe("target-start\ncopy-me\ntarget-end\n");
        });
    });
    test("copies a selected range inside the same file", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const file = await createFixture(directory, "same-file-copy.txt", "first\ncopy-me\nlast\n");
            const relativeFile = path.relative(directory, file);
            const scenario = await runTextToolScenario({
                extensions: extensions.paths,
                cwd: directory,
                testName: "text-editor-copy-same-file",
                tool: "copy",
                arguments: {
                    path: relativeFile,
                    start: formatLineHashAnchor(2, "copy-me"),
                    target: relativeFile,
                    targetStart: formatLineHashAnchor(3, "last"),
                },
            });

            expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
            await expect(readFile(file, "utf8")).resolves.toBe("first\ncopy-me\nlast\ncopy-me\n");
        });
    });
});
