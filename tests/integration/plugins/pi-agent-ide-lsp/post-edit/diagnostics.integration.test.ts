import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution, getToolExecutionDetails, getToolResultText } from "pi-coding-agent-test";
import { generateReadExtensions } from "pi-agent-read/testing";
import { afterAll, expect, test } from "vitest";

import {
  expectTextToolDiff,
  getTextToolMutationData,
  runTextToolScenario,
} from "#integration-tests/support/pi-runtime/scenario.js";

const repoRoot = process.cwd();
const generatedExtensions = await generateReadExtensions([
  path.join(repoRoot, "tests/integration/extensions/pi-agent-text-editor/register-extension.ts"),
  path.join(
    repoRoot,
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  ),
  path.join(repoRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
  path.join(repoRoot, "src/index.ts"),
  path.join(repoRoot, "src/plugins/pi-agent-ide-lsp/index.ts"),
]);
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-ide-post-edit-lsp");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("an edit returns diagnostics from the written TypeScript file", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "diagnostics.ts";
    const before = "export const value = 1;\n";
    const after = "export const value: string = 1;\n";
    const file = path.join(directory, fileName);
    const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });

    await writeFile(
      path.join(configDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "typescript-language-server": {
            command: [path.join(repoRoot, "node_modules/.bin/tsc"), "--lsp", "--stdio"],
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
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: [fileName],
      }),
      "utf8",
    );
    await writeFile(file, before, "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-lsp-diagnostics",
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(1, "export const value = 1;"),
        text: "export const value: string = 1;",
      },
    });

    expect(await readFile(file, "utf8")).toBe(after);
    expectTextToolDiff(scenario, fileName, before, after);

    const mutationOutput = getToolResultText(scenario.result, scenario.mutationCallId);
    expect(mutationOutput).toMatch(/^-\| {6}\|export const value = 1;$/mu);
    expect(mutationOutput).toMatch(/^\+\|1#[A-Z0-9]{4}\|export const value: string = 1;/mu);

    const details = getToolExecutionDetails(
      getToolExecution(scenario.result, scenario.mutationCallId),
    );
    const data = getTextToolMutationData(details);
    expect(data.hints).toEqual([
      expect.objectContaining({
        file: fileName,
        line: 1,
        code: "2322",
        severity: "error",
        source: "compiler",
      }),
    ]);
    expect(
      JSON.stringify(getToolExecution(scenario.result, scenario.mutationCallId).result),
    ).toContain("compiler:2322");
    expect(getToolResultText(scenario.result, scenario.postflightCallIds[0])).toContain("lsp:2322");
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
