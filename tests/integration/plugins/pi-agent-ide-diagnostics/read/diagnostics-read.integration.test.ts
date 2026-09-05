import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultMessage,
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
  "src/core/extension.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/plugins/pi-agent-ide-lint/index.ts",
  "src/plugins/pi-agent-ide-lsp/index.ts",
  "src/plugins/pi-agent-ide-diagnostics/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-diagnostics");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("diagnostics source combines lint and LSP with context and normal ranges", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "diagnostics.js";
    const source = [
      "export function checkValue() {",
      "    // context 2",
      "    // context 3",
      "    // context 4",
      "    // context 5",
      "    // context 6",
      '    console.log("debug");',
      "    // context 8",
      "    // context 9",
      "    // context 10",
      '    const value = /** @type {number} */ ("wrong");',
      "    // context 12",
      "    // context 13",
      "    // context 14",
      "    // context 15",
      "    return value;",
      "}",
      "",
    ].join("\n");
    await writeProject(directory, fileName, source);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-combined-diagnostics",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-diagnostics-source",
              name: "read",
              arguments: { path: `diagnostics:${fileName}`, views: ["anchors"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-diagnostics-range",
              name: "read",
              arguments: { path: `diagnostics:${fileName}`, offset: 2, limit: 3 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-diagnostics-view",
              name: "read",
              arguments: { path: fileName, offset: 7, limit: 5, views: ["diagnostics"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-old-lint-source",
              name: "read",
              arguments: { path: `lint:${fileName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-old-lsp-source",
              name: "read",
              arguments: { path: `lsp:${fileName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The combined diagnostic reads finished")]),
      ],
    }).run("Read the file's combined diagnostics and nearby source");

    const focused = getToolResultText(result, "read-diagnostics-source");
    expect(focused).toContain("// context 2");
    expect(focused).toContain("// context 15");
    expect(focused).not.toContain("export function checkValue");
    expect(focused).not.toMatch(/\n\s*17#[A-Z0-9]{4}\|/u);
    expect(focused).toContain("<!-- lint:");
    expect(focused).toContain("lint:no-console");
    expect(focused).toContain("<!-- lsp:");
    expect(focused).toContain("lsp:2352");
    expect(focused).toMatch(/7#[A-Z0-9]{4}\|/u);
    expect(focused).toMatch(/11#[A-Z0-9]{4}\|/u);

    const focusedMessage = getToolResultMessage(result, "read-diagnostics-source");
    expect((focusedMessage.details as { readonly source?: string }).source).toMatch(
      /^diagnostics:\/.*\/diagnostics\.js$/u,
    );

    const ranged = getToolResultText(result, "read-diagnostics-range");
    expect(ranged).toContain("// context 3");
    expect(ranged).toContain("// context 5");
    expect(ranged).not.toContain("// context 2");
    expect(ranged).not.toContain("// context 6");

    const annotated = getToolResultText(result, "read-diagnostics-view");
    expect(annotated).toContain("<!-- lint:");
    expect(annotated).toContain("<!-- lsp:");
    expect(annotated).not.toContain("// context 6");

    expect(getToolExecution(result, "read-old-lint-source").isError).toBe(true);
    expect(getToolExecution(result, "read-old-lsp-source").isError).toBe(true);
  });
}, 120_000);

async function writeProject(directory: string, fileName: string, source: string): Promise<void> {
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
    path.join(configDirectory, "lsp-servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "typescript-language-server": {
          command: [path.join(process.cwd(), "node_modules/.bin/tsc"), "--lsp", "--stdio"],
          rootMarkers: ["tsconfig.json"],
          languages: { javascript: { extensions: [".js"] } },
          capabilities: ["diagnostics"],
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
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: true },
      include: [fileName],
    }),
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
