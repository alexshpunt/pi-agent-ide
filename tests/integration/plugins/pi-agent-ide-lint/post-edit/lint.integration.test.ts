import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { getToolExecution, getToolResultText } from "pi-coding-agent-test";
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
  path.join(repoRoot, "src/plugins/pi-agent-ide-lint/index.ts"),

  path.join(repoRoot, "src/plugins/pi-agent-ide-diagnostics/index.ts"),
]);
const tempRoot = path.join(repoRoot, ".tmp/pi-agent-ide-post-edit-lint");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("background lint reports fixable errors without changing the edited file", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "lint-fix.js";
    const before = 'export const value = "before";\n';
    const requested = "export const value = 'after';\n";
    const file = path.join(directory, fileName);
    const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    const eslintArguments = [
      "--format",
      "json",
      "--cache",
      "--cache-strategy",
      "content",
      "--cache-location",
      ".cache/eslintcache",
      "{file}",
    ];

    await writeFile(
      path.join(configDirectory, "linters.json"),
      JSON.stringify({
        version: 1,
        linters: {
          eslint: {
            extensions: [".js"],
            check: { command: ["eslint_d", ...eslintArguments] },
            fix: { command: ["eslint_d", "--fix", ...eslintArguments] },
            diagnostics: { format: "eslint-json" },
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(directory, "eslint.config.mjs"),
      ['export default [{ files: ["**/*.js"], rules: { quotes: ["error", "double"] } }];', ""].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(file, before, "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-lint-fix",

      postflightViews: ["diagnostics"],
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(1, 'export const value = "before";'),
        text: requested.trimEnd(),
      },
    });

    expect(await readFile(file, "utf8")).toBe(requested);
    expectTextToolDiff(scenario, fileName, before, requested);
    const output = getToolResultText(scenario.result, scenario.mutationCallId);
    expect(output).toContain("export const value = 'after'");
    expect(output).not.toContain("<!-- lint:");
    expect(getToolResultText(scenario.result, scenario.postflightCallIds[0])).toContain(
      "lint:quotes",
    );
  });
}, 60_000);

test("malformed linter output does not break an edit", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "malformed-lint.ts";
    const before = "export const value = 1;\n";
    const after = "export const value = 2;\n";
    const file = path.join(directory, fileName);
    const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "linters.json"),
      JSON.stringify({
        version: 1,
        linters: {
          oxlint: {
            extensions: [".ts"],
            check: {
              command: [
                process.execPath,
                "-e",
                "process.stdout.write('This oxlint output is not SARIF'); process.exitCode = 1",
              ],
              successExitCodes: [0, 1],
            },
            diagnostics: { format: "sarif" },
          },
        },
      }),
      "utf8",
    );
    await writeFile(file, before, "utf8");

    const scenario = await runTextToolScenario({
      extensions: generatedExtensions.paths,
      cwd: directory,
      testName: "post-edit-malformed-lint",
      tool: "replace",
      arguments: {
        path: fileName,
        start: formatLineHashAnchor(1, before.trimEnd()),
        text: after.trimEnd(),
      },
    });

    expect(await readFile(file, "utf8")).toBe(after);
    expect(getToolExecution(scenario.result, scenario.mutationCallId).isError).toBe(false);
    expect(scenario.result.tuiRenderedOutput).not.toContain("lint failed for");
    expect(scenario.result.tuiRenderedOutput).not.toContain("SyntaxError");
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
