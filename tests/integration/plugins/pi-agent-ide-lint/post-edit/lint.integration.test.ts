import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolResultText } from "pi-coding-agent-test";
import { generateReadExtensions } from "pi-agent-read/testing";
import { afterAll, expect, test } from "vitest";

import {
    expectTextToolDiff,
    runTextToolScenario,
} from "#integration-tests/support/pi-runtime/scenario.js";

const repoRoot = process.cwd();
const generatedExtensions = await generateReadExtensions([
    path.join(repoRoot, "tests/integration/extensions/pi-agent-text-editor/register-extension.ts"),
    path.join(repoRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts"),
    path.join(repoRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
    path.join(repoRoot, "index.ts"),
    path.join(repoRoot, "src/plugins/pi-agent-ide-lint/index.ts"),
]);
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-ide-post-edit-lint");

afterAll(async () =>
{
    await generatedExtensions.dispose();
    await rm(tempRoot, { recursive: true, force: true });
});

test("an edit returns the file after the configured linter fixes it", async () =>
{
    await withTempDirectory(async (directory) =>
    {
        const fileName = "lint-fix.js";
        const before = "export const value = \"before\";\n";
        const requested = "export const value = 'after';\n";
        const fixed = "export const value = \"after\";\n";
        const file = path.join(directory, fileName);

        await writeFile(path.join(directory, "linters.json"), JSON.stringify({
            linters: {
                eslint: {
                    extensions: [".js"],
                    command: [
                        "eslint_d",
                        "--fix",
                        "--format",
                        "json",
                        "--cache",
                        "--cache-strategy",
                        "content",
                        "--cache-location",
                        ".cache/eslintcache",
                    ],
                },
            },
        }), "utf8");
        await writeFile(path.join(directory, "eslint.config.mjs"), [
            "export default [{ files: [\"**/*.js\"], rules: { quotes: [\"error\", \"double\"] } }];",
            "",
        ].join("\n"), "utf8");
        await writeFile(file, before, "utf8");

        const scenario = await runTextToolScenario({
            extensions: generatedExtensions.paths,
            cwd: directory,
            testName: "post-edit-lint-fix",
            tool: "replace",
            arguments: {
                path: fileName,
                start: formatLineHashAnchor(1, "export const value = \"before\";"),
                text: requested.trimEnd(),
            },
        });

        expect(await readFile(file, "utf8")).toBe(fixed);
        expectTextToolDiff(scenario, fileName, before, fixed);

        const output = getToolResultText(scenario.result, scenario.mutationCallId);
        expect(output).toContain("export const value = \"after\"");
        expect(output).not.toContain("export const value = 'after'");
    });
}, 60_000);

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