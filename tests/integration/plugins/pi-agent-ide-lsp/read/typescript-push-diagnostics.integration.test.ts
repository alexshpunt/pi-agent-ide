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
  "src/core/extension.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/plugins/pi-agent-ide-ast/index.ts",
  "src/plugins/pi-agent-ide-lsp/index.ts",
  "src/plugins/pi-agent-ide-diagnostics/index.ts",
]);
const tempRoot = path.resolve(".agents/tmp/typescript-push-diagnostics");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("TypeScript push diagnostics appear in focused, annotated, and combined reads", async () => {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));
  try {
    const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(path.join(directory, "src"));
    await writeFile(
      path.join(configDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "typescript-language-server": {
            command: ["typescript-language-server", "--stdio"],
            rootMarkers: ["tsconfig.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      }),
    );
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ["src/*.ts"],
      }),
    );
    const source =
      'export function intentionalDiagnostic(): number {\n  return "tool-validation-diagnostic";\n  // Keep the scope long enough for AST markers.\n}\n';
    const file = path.join(directory, "src/catalog.ts");
    await writeFile(file, source);
    const calls = [
      { id: "focused", arguments: { path: "diagnostics:src/catalog.ts" } },
      { id: "annotated", arguments: { path: "src/catalog.ts", views: ["diagnostics"] } },
      {
        id: "combined",
        arguments: { path: "src/catalog.ts", views: ["anchors", "ast", "diagnostics"] },
      },
    ];
    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(import.meta.filename),
      testName: "typescript-push-diagnostic-reads",
      cwd: directory,
      extensions: [...generatedExtensions.paths, "builtin:codemode"],
      tools: ["read", "codemode"],
      conversation: [
        // Agent reads may truthfully return pending after five seconds. A script read
        // explicitly waits for the completed check before testing all three presentations.
        assistantMessage(
          [
            toolCall({
              id: "diagnostic-ready",
              name: "codemode",
              arguments: {
                code: 'await tools.read({path:"diagnostics:src/catalog.ts"}); text("Diagnostic check completed.");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...calls.map((call) =>
          assistantMessage([toolCall({ ...call, name: "read" })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Diagnostic reads finished.")]),
      ],
    }).run("Read the TypeScript error through each diagnostics form.");
    expect(
      getToolExecution(result, "diagnostic-ready").isError,
      getToolResultText(result, "diagnostic-ready"),
    ).toBe(false);
    const completed = getToolExecution(result, "diagnostic-ready/1");
    expect(completed.isError).toBe(false);
    expect(completed.result).toHaveProperty("details.diagnosticCheck", {
      complete: true,
      count: 1,
      sources: ["typescript-language-server"],
    });
    expect(completed.result).toHaveProperty(
      "content.0.text",
      expect.stringContaining("typescript-language-server:2322"),
    );
    for (const call of calls) {
      expect(getToolExecution(result, call.id).isError).toBe(false);
      const output = getToolResultText(result, call.id);
      expect(output).toContain("typescript-language-server:2322");
      expect(output).toContain("Type 'string' is not assignable to type 'number'.");
    }
    const combined = getToolResultText(result, "combined");
    expect(combined).toMatch(/2#[A-Z0-9]{4}\|/u);
    expect(combined).toContain("scope-begin-");
    expect(await readFile(file, "utf8")).toBe(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
