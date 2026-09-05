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
  path.join(
    repoRoot,
    "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  ),
  path.join(repoRoot, "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
  path.join(repoRoot, "src/index.ts"),
  path.join(repoRoot, "src/plugins/pi-agent-ide-formatter/index.ts"),
]);
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-ide-post-edit-formatter");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("an edit returns the formatter result instead of the requested intermediate text", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "formatter.ts";
    const before = "export const value = 1;\n";
    const requestedLine = "export const value={answer:2};";
    const formatted = "export const value = { answer: 2 };\n";
    const file = path.join(directory, fileName);
    const formatterScript = path.join(directory, "format.mjs");
    const agentDirectory = path.join(directory, "agent");
    const globalConfigDirectory = path.join(agentDirectory, "extensions", "pi-agent-ide");
    const projectConfigDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(globalConfigDirectory, { recursive: true });
    await mkdir(projectConfigDirectory, { recursive: true });

    await writeFile(
      formatterScript,
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        "const file = process.argv[2];",
        'const source = await readFile(file, "utf8");',
        'await writeFile(file, source.replace("export const value={answer:2};", "export const value = { answer: 2 };"), "utf8");',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(globalConfigDirectory, "formatters.json"),
      JSON.stringify({
        version: 1,
        formatters: {
          fixture: {
            extensions: [".ts"],
            run: { command: ["node", formatterScript, "{file}"] },
            output: "in-place",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(projectConfigDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "fixture-formatter": {
            command: ["node", "--version"],
            rootMarkers: ["lsp-servers.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: [],
          },
        },
      }),
      "utf8",
    );
    await writeFile(file, before, "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-formatter",

      isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(1, "export const value = 1;"),
        text: requestedLine,
      },
    });

    expect(scenario.result.tuiRenderedOutput).not.toContain("Event handler error");

    expect(await readFile(file, "utf8")).toBe(formatted);
    expectTextToolDiff(scenario, fileName, before, formatted);

    const output = getToolResultText(scenario.result, scenario.mutationCallId);
    expect(output).toContain("export const value = { answer: 2 };");
    expect(output).not.toContain(requestedLine);
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
