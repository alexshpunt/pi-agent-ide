import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultMessage,
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
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/plugins/pi-agent-ide-lint/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-lint");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("read shows lint diagnostics without changing the source", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "lint-diagnostics.js";
    const file = path.join(directory, fileName);
    const source = ["export function logValue() {", '    console.log("debug");', "}", ""].join(
      "\n",
    );
    await writeJavaScriptProject(directory, fileName, source);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-lint-diagnostics",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-lint-diagnostics",
              name: "read",
              arguments: { path: fileName, offset: 2, limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The lint diagnostic read finished")]),
      ],
    }).run("Read the invalid JavaScript line and inspect its lint diagnostics");

    expect(await readFile(file, "utf8")).toBe(source);

    const rendered = getToolResultText(result, "read-lint-diagnostics");
    expect(rendered).toContain('console.log("debug")');
    expect(rendered).toContain("[WARNING] lint:no-console: Unexpected console statement");
    expect(rendered).toContain("<!-- lint:");
    expect(rendered).not.toContain("export function logValue");

    const message = getToolResultMessage(result, "read-lint-diagnostics");
    const details = message.details as {
      readonly startLine?: number;
      readonly endLine?: number;
      readonly totalLines?: number;
      readonly lines?: readonly { readonly lineNumber: number }[];
    };

    expect(details).toMatchObject({ startLine: 2, endLine: 2, totalLines: 3 });
    expect(details.lines?.map((line) => line.lineNumber)).toEqual([2]);
    expect(details.lines?.[0]).not.toHaveProperty("hints");
  });
}, 60_000);

test("lint protocol returns only lines with diagnostics", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "lint-protocol.js";
    const source = [
      "export function logValues() {",
      '    console.log("first");',
      "    const clean = 1;",
      "    console.log(clean);",
      "}",
      "",
    ].join("\n");
    await writeJavaScriptProject(directory, fileName, source);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-lint-protocol",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-lint-protocol",
              name: "read",
              arguments: { path: `lint:${fileName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The lint protocol read finished")]),
      ],
    }).run("Read only the lines reported by the linter");

    const rendered = getToolResultText(result, "read-lint-protocol");
    expect(rendered).toContain('console.log("first")');
    expect(rendered).toContain("console.log(clean)");
    expect(rendered).toContain("[WARNING] lint:no-console: Unexpected console statement");
    expect(rendered).toMatch(/2#[A-Z0-9]{4}\|/u);
    expect(rendered).toMatch(/4#[A-Z0-9]{4}\|/u);
    expect(rendered).not.toContain("export function logValues");
    expect(rendered).not.toContain("const clean = 1");

    const message = getToolResultMessage(result, "read-lint-protocol");
    const details = message.details as { readonly source?: string };
    expect(details.source).toMatch(/^lint:\/.*\/lint-protocol\.js$/u);
  });
}, 60_000);

async function writeJavaScriptProject(
  directory: string,
  fileName: string,
  source: string,
): Promise<void> {
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, "linters.json"),
    JSON.stringify({
      version: 1,
      linters: {
        eslint: {
          extensions: [".js"],
          check: {
            command: [
              "eslint_d",
              "--format",
              "json",
              "--cache",
              "--cache-strategy",
              "content",
              "--cache-location",
              ".cache/eslintcache",
              "{file}",
            ],
          },
          diagnostics: { format: "eslint-json" },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "eslint.config.mjs"),
    ['export default [{ files: ["**/*.js"], rules: { "no-console": "error" } }];', ""].join("\n"),
    "utf8",
  );
  await writeFile(path.join(directory, fileName), source, "utf8");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
