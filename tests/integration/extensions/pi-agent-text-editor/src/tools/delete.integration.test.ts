import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution } from "pi-coding-agent-test";
import { describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expectTextToolDiff, runTextToolScenario } from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();

describe("pi-agent-text-editor delete", () =>
{
    test("deletes the selected line", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const file = await createFixture(directory, "delete.txt", "before\ndelete-me\nafter\n");
            const relativeFile = path.relative(directory, file);
            const scenario = await runTextToolScenario({
                extensions: extensions.paths,
                cwd: directory,
                testName: "text-editor-delete",
                tool: "delete",
                arguments: { path: relativeFile, start: formatLineHashAnchor(2, "delete-me") },
            });
            expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
            expectTextToolDiff(scenario, relativeFile, "before\ndelete-me\nafter\n", "before\nafter\n");
            await expect(readFile(file, "utf8")).resolves.toBe("before\nafter\n");
        });
    });
});