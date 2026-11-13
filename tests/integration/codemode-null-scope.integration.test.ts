import { mkdir, writeFile } from "node:fs/promises";
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
import { expect, test } from "vitest";

import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

type Call = Parameters<typeof toolCall>[0];

async function run(cwd: string, code: string, direct: readonly Call[] = []) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(path.join(cwd, "a.ts"), "export const needle = 1;\n");
  return new PiIntegrationTest({
    testName: "codemode-null-scope",
    artifactsDir: testArtifactsDir(import.meta.filename),
    rawMode: false,
    cwd,
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["search", "file_search", "ast_search", "lsp_search", "codemode"],
    conversation: [
      assistantMessage(
        [
          toolCall({ id: "script", name: "codemode", arguments: { code } }),
          ...direct.map((call) => toolCall(call)),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Search with a null scope");
}

test("a null path fails in every search tool, while an omitted path searches the working directory", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(
      cwd,
      `const nulls = await Promise.all([
  tools.search({ path: null, query: "needle" }),
  tools.file_search({ path: null, pattern: "a.ts" }),
  tools.ast_search({ path: null, pattern: "needle" }),
  tools.lsp_search({ path: null, query: "needle" }),
]);
const omitted = await Promise.all([
  tools.search({ query: "needle" }),
  tools.file_search({ pattern: "a.ts" }),
]);
text("nulls:" + JSON.stringify(nulls.map((value) => value === null)));
text("omitted:" + JSON.stringify(omitted.map((value) => value !== null)));`,
      [
        { id: "direct-null", name: "search", arguments: { query: "needle", path: null } },
        { id: "direct-omitted", name: "search", arguments: { query: "needle" } },
      ],
    );

    const directNull = getToolResultText(result, "direct-null");
    expect(getToolExecution(result, "direct-null").isError, directNull).toBe(true);
    expect(directNull).toContain("path is null");
    expect(getToolExecution(result, "direct-omitted").isError).toBe(false);
    expect(getToolResultText(result, "direct-omitted")).toContain("a.ts");

    const output = getToolResultText(result, "script");
    expect(getToolExecution(result, "script").isError, output).toBe(false);
    expect(output).toContain("nulls:[true,true,true,true]");
    expect(output).toContain("omitted:[true,true]");
    const block = codemodeFailures(output);
    expect(block, output).toContain("4 of 6 IDE calls failed:");
    for (const tool of ["search", "file_search", "ast_search", "lsp_search"])
      expect(block).toContain(`- ${tool}`);
    expect(block.match(/path is null/gu)).toHaveLength(4);
    expect(block).toContain("failed or selected no text");
  });
});
