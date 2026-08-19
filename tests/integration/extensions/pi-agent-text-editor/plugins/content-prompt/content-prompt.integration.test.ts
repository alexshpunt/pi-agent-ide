import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getProviderSystemPrompt,
    PiIntegrationTest,
    testArtifactsDir,
    text,
} from "pi-coding-agent-test";
import { afterAll, beforeAll, expect, test } from "vitest";

import { generateContentPromptExtensions } from "#integration/src/extensions/pi-agent-text-editor/plugins/content-prompt/support/generate-content-prompt-extensions.js";

const generatedExtensions = await generateContentPromptExtensions();
const cwd = path.resolve(".tmp/pi-agent-text-editor-content-prompt");
const expectedSection = [
    "# Writable Resources",
    "",
    "- `filesystem` — Writes local filesystem paths.",
    "  - `text` — UTF-8 text.",
    "",
    "# Text Editor Tools Extensions",
    "",
    "`write`:",
    "",
    "- `write-pipeline` — Adds fixture write behavior.",
].join("\n");

beforeAll(() => mkdir(cwd, { recursive: true }));
afterAll(async () =>
{
    await generatedExtensions.dispose();
    await rm(cwd, { recursive: true, force: true });
});

test("assembles installed writable content types beside tool descriptions", async () =>
{
    const result = await runPrompt("content-prompt-write-active", ["write"]);
    const prompt = getProviderSystemPrompt(result);

    expect(prompt).toContain(expectedSection);
    expect(prompt.match(/# Writable Resources/gu)).toHaveLength(1);
    expect(prompt.match(/# Text Editor Tools Extensions/gu)).toHaveLength(1);
    const writableStart = prompt.indexOf("# Writable Resources");
    const writableEnd = prompt.indexOf("\n\n# Text Editor Tools Extensions", writableStart);
    expect(prompt.slice(writableStart, writableEnd)).not.toContain("`image`");
});

test("omits writable content types when no registered editor tool is selected", async () =>
{
    const result = await runPrompt("content-prompt-write-inactive", []);
    expect(getProviderSystemPrompt(result)).not.toContain("# Writable Resources");
});

function runPrompt(testName: string, tools: readonly string[])
{
    return new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd,
        extensions: generatedExtensions.paths,
        tools,
        conversation: [assistantMessage([text("The writable content prompt was inspected")])],
    }).run("Inspect installed writable content types");
}
