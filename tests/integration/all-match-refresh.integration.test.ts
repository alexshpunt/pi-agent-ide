import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
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

async function run(cwd: string, name: string, tools: string[], steps: Step[]) {
  await mkdir(path.join(cwd, ".pi-agent"), { recursive: true });
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
    tools,
    conversation: [
      ...steps.map((step) =>
        assistantMessage(
          [toolCall({ ...step, chunks: { kind: "fixed", size: 65536 }, delayMs: 0 })],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done", { delayMs: 0 })]),
    ],
  }).run("Use an all-match anchor after the file changed.");
}

test("references found from a Search match stay usable as an all-match anchor after another edit", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = [
      "// header",
      "inline float dot(float a, float b);",
      "inline float dot(float a, float b) { return a * b; }",
      "float first() { return dot(1, 2); }",
      "float second() { return dot(3, 4) + dot(5, 6); }",
      "int main() { return static_cast<int>(first() + second()); }",
      "",
    ].join("\n");
    await writeFile(path.join(cwd, "main.cpp"), source);
    const result = await run(
      cwd,
      "all-match-lsp-scope-refresh",
      ["read", "search", "lsp_search", "replace"],
      [
        // clangd answers symbol searches from an index it fills after parsing the opened file.
        { id: "warm", name: "lsp_search", arguments: { calls: "main.cpp#first" } },
        {
          id: "declaration",
          name: "search",
          arguments: { path: "main.cpp", query: "inline float dot(float a, float b);" },
        },
        {
          id: "references",
          name: "lsp_search",
          arguments: {
            query: "dot",
            path: "$issued-searchmatch:declaration:1",
            references: true,
          },
        },
        // Another edit elsewhere in the file: the declaration scope moves down one line.
        {
          id: "elsewhere",
          name: "replace",
          arguments: { path: "main.cpp", start: "// header", text: "// header\n// added" },
        },
        {
          id: "rename",
          name: "replace",
          arguments: { path: "$issued-searchallmatch:references", text: "dot_product" },
        },
      ],
    );
    for (const id of ["warm", "declaration", "references", "elsewhere", "rename"]) {
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    }
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(
      source.replace("// header", "// header\n// added").replaceAll("dot(", "dot_product("),
    );
  });
}, 180_000);

test("a limited all-match anchor says how to get every match and prints no file text", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "const value = 1;\nconst other = value + value;\n";
    await writeFile(path.join(cwd, "note.ts"), source);
    const result = await run(
      cwd,
      "all-match-limited",
      ["ast_search", "replace"],
      [
        {
          id: "found",
          name: "ast_search",
          arguments: { path: "note.ts", pattern: "value", limit: 1 },
        },
        {
          id: "rename",
          name: "replace",
          // A limited result prints no all-anchor; agents write one from its numbered anchors.
          arguments: { path: "$issued-searchid:found:all:match", text: "amount" },
        },
      ],
    );
    expect(getToolExecution(result, "rename").isError).toBe(true);
    const failure = getToolResultText(result, "rename");
    expect(failure).toMatch(/path anchor "SEARCH#[A-F\d]+:all:match" was not found: /u);
    expect(failure).toContain("search again with a higher limit or a narrower path");
    expect(failure).not.toContain("const other");
    expect(failure).not.toContain("represented below");
    expect(await readFile(path.join(cwd, "note.ts"), "utf8")).toBe(source);
  });
}, 120_000);
