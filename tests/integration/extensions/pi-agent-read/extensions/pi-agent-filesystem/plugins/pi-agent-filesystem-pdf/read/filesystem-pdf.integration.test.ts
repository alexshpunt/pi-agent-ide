import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-pdf/index.ts",
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
]);
afterAll(() => generatedExtensions.dispose());
const tempRoot = path.resolve(".tmp/pi-agent-filesystem-pdf");
const pdf = Buffer.from("JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NiA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjcyIDcyMCBUZAooSGVsbG8gZnJvbSBQREYpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcgMCBSID4+ID4+IC9Db250ZW50cyA2IDAgUiA+PgplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDQzID4+CnN0cmVhbQpCVAovRjEgMTggVGYKNzIgNzIwIFRkCihTZWNvbmQgcGFnZSkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNDIgMDAwMDAgbiAKMDAwMDAwMDQ2OCAwMDAwMCBuIAowMDAwMDAwNTYwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjMwCiUlRU9GCg==", "base64");

test("reads a local PDF as page-oriented text and supports text ranges", async () =>
{
    await withTempDirectory(async directory =>
    {
        await writeFile(path.join(directory, "document.pdf"), pdf);
        const content = getToolResultText(await runRead(directory, "document.pdf", "filesystem-pdf"));
        expect(content).toContain("## Page 1 of 2\n\nHello from PDF");
        expect(content).toContain("## Page 2 of 2\n\nSecond page");

        const ranged = getToolResultText(await runRead(directory, "document.pdf", "filesystem-pdf-range", {
            offset: 3,
            limit: 3,
        }));
        expect(ranged).toContain("Hello from PDF");
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
    const directory = await mkdtemp(path.join(tempRoot, "filesystem-pdf-"));

    try
    {
        await callback(directory);
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}
