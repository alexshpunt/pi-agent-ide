import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
    assistantMessage,
    getProviderSystemPrompt,
    PiIntegrationTest,
    testArtifactsDir,
    text,
} from "pi-coding-agent-test/base";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-image/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-web/index.ts",
]);
const tempRoot = path.resolve(".tmp");
await mkdir(tempRoot, { recursive: true });
const cwd = await mkdtemp(path.join(tempRoot, "pi-agent-read-content-prompt-"));
const expectedSection = [
    "# Read Extensions",
    "",
    "- `filesystem` — Reads local filesystem paths and file:// URLs. Directories are read-only listings.",
    "  - `image` — JPEG, static PNG, GIF, WebP, and BMP images.",
    "  - `text` — UTF-8 text.",
    "- `web` — Reads HTTP(S) URLs.",
    "  - `image` — JPEG, static PNG, GIF, WebP, and BMP images.",
    "  - `html` — HTML and XHTML pages converted to Markdown.",
    "  - `text` — UTF-8 text.",
].join("\n");

afterAll(async () =>
{
    await generatedExtensions.dispose();
    await rm(cwd, { recursive: true, force: true });
});

test("assembles installed provider content types in the read system prompt", async () =>
{
    const result = await runPrompt("content-prompt-read-active", ["read"]);
    const prompt = getProviderSystemPrompt(result);

    expect(prompt).toContain(expectedSection);
    expect(prompt.match(/# Read Extensions/gu)).toHaveLength(1);
});
test("omits installed read content types when read is not selected", async () =>
{
    const result = await runPrompt("content-prompt-read-inactive", []);
    expect(getProviderSystemPrompt(result)).not.toContain("# Read Extensions");
});

function runPrompt(testName: string, tools: readonly string[])
{
    return new PiIntegrationTest({
        artifactsDir: testArtifactsDir(expect.getState().testPath),
        testName,
        cwd,
        extensions: generatedExtensions.paths,
        tools,
        conversation: [assistantMessage([text("The content prompt was inspected")])],
    }).run("Inspect installed read content types");
}
