import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
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
  "src/index.ts",
  "src/plugins/pi-agent-ide-ast/index.ts",
  "src/plugins/pi-agent-ide-lsp/index.ts",
  "src/plugins/pi-agent-ide-lint/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-ide");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("loads IDE extensions together while preserving read integrations", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "ide-aggregation.js";
    const file = path.join(directory, fileName);
    const source = ["export function readValue() {", "    return 1;", "}", ""].join("\n");
    await writeFile(file, source, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "ide-aggregation",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "ide-aggregation-read",
              name: "read",
              arguments: { path: fileName },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The IDE aggregation read finished")]),
      ],
    }).run("Read a source file through the IDE extension bundle");

    expect(await readFile(file, "utf8")).toBe(source);
    expect(getToolExecution(result, "ide-aggregation-read").isError).not.toBe(true);
    expect(getToolResultText(result, "ide-aggregation-read")).toContain(
      "export function readValue()",
    );
    expect(getToolResultText(result, "ide-aggregation-read")).toContain("return 1;");
  });
}, 60_000);

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
