import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

interface Step {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, JsonValue>;
}

const listed = ["src/code-view", "src/api"];

async function workspace(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".git"));
  await mkdir(path.join(cwd, ".pi-agent"));
  await writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, paths: { "#format": ["./src/code-view/format.ts"] } },
      include: ["src"],
    }),
  );
  const importFormat = 'import { formatSymbolSelector } from "#format";\n\n';
  const files: Record<string, string> = {
    "src/code-view/format.ts":
      "export function formatSymbolSelector(name: string): string {\n  return name;\n}\n",
    "src/api/use.ts": `${importFormat}export const used = formatSymbolSelector("api");\n`,
    "src/other/skip.ts": `${importFormat}export const skipped = formatSymbolSelector("other");\n`,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), content);
  }
}

async function run(cwd: string, name: string, steps: readonly Step[]) {
  return new PiIntegrationTest({
    testName: name,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    transport: "rpc",
    rawMode: false,
    environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
    extensions: [
      path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
      path.resolve("src/pi-agent-ide.ts"),
    ],
    tools: ["read", "search", "file_search", "ast_search", "lsp_search"],
    conversation: [
      ...steps.map((step) =>
        assistantMessage(
          [toolCall({ ...step, chunks: { kind: "fixed", size: 65536 }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Search the listed directories.");
}

test("search tools search a list of directories as one scope", async () => {
  await withTempWorkspace(async (cwd) => {
    await workspace(cwd);
    const result = await run(cwd, "search-path-list", [
      { id: "text", name: "search", arguments: { path: listed, query: "formatSymbolSelector" } },
      { id: "files", name: "file_search", arguments: { path: listed, pattern: "*.ts" } },
      {
        id: "ast",
        name: "ast_search",
        arguments: { path: listed, pattern: "formatSymbolSelector($$$ARGS)" },
      },
      { id: "lsp", name: "lsp_search", arguments: { path: listed, query: "formatSymbolSelector" } },
    ]);
    for (const id of ["text", "files", "ast", "lsp"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);

    const textOutput = getToolResultText(result, "text");
    expect(textOutput).toContain("3 matches in 2 files");
    expect(textOutput).not.toContain("src/other");
    expect(getToolExecutionDetails(getToolExecution(result, "files"))).toMatchObject({
      resolverId: "files",
      payload: { files: ["src/api/use.ts", "src/code-view/format.ts"], complete: true },
    });
    const astOutput = getToolResultText(result, "ast");
    expect(astOutput).toContain("src/api/use.ts:3");
    expect(astOutput).not.toContain("src/other");
    const lspOutput = getToolResultText(result, "lsp");
    expect(lspOutput).toContain("src/code-view/format.ts");
    expect(lspOutput).toContain("src/api/use.ts");
    expect(lspOutput).not.toContain("src/other");
  });
}, 180_000);

test("a file listed twice or inside a listed directory is searched once", async () => {
  await withTempWorkspace(async (cwd) => {
    await workspace(cwd);
    const overlapping = ["src/api", "src/api/use.ts", "./src/api", "src/code-view/format.ts"];
    const result = await run(cwd, "search-path-list-overlap", [
      {
        id: "text",
        name: "search",
        arguments: { path: overlapping, query: "formatSymbolSelector" },
      },
      { id: "files", name: "file_search", arguments: { path: overlapping, pattern: "*.ts" } },
      {
        id: "ast",
        name: "ast_search",
        arguments: { path: overlapping, pattern: "formatSymbolSelector($$$ARGS)" },
      },
    ]);
    for (const id of ["text", "files", "ast"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolResultText(result, "text")).toContain("3 matches in 2 files");
    expect(getToolExecutionDetails(getToolExecution(result, "files"))).toMatchObject({
      payload: { files: ["src/api/use.ts", "src/code-view/format.ts"], complete: true },
    });
    const astOutput = getToolResultText(result, "ast");
    expect(astOutput.match(/src\/api\/use\.ts:3:/gu), astOutput).toHaveLength(1);
  });
}, 180_000);

test("a list that mixes paths and results names the accepted forms", async () => {
  await withTempWorkspace(async (cwd) => {
    await workspace(cwd);
    const mixed = ["src/api", "$issued-uuid:read"];
    const result = await run(cwd, "search-path-list-mixed", [
      { id: "read", name: "read", arguments: { path: "src/code-view/format.ts" } },
      { id: "text", name: "search", arguments: { path: mixed, query: "formatSymbolSelector" } },
      { id: "files", name: "file_search", arguments: { path: mixed, pattern: "*.ts" } },
      {
        id: "ast",
        name: "ast_search",
        arguments: { path: mixed, pattern: "formatSymbolSelector($$$ARGS)" },
      },
      { id: "lsp", name: "lsp_search", arguments: { path: mixed, query: "formatSymbolSelector" } },
    ]);
    for (const id of ["text", "ast", "lsp"]) {
      expect(getToolExecution(result, id).isError).toBe(true);
      expect(getToolResultText(result, id)).toContain(
        "either file and directory paths or Read/Search/edit results",
      );
    }
    expect(getToolExecution(result, "files").isError).toBe(true);
    expect(getToolResultText(result, "files")).toContain(
      "file_search takes file and directory paths, not Read/Search results",
    );
  });
}, 180_000);
