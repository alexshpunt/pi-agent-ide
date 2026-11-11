import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

// Clang binds each misspelled call within a small edit distance to the declared function and
// clangd then lists and renames it as a reference. Only the last call names the function.
const MISSPELLED = 30;
const SOURCE = [
  "struct Widget {",
  "  Widget() {}",
  "};",
  "void call_normalize_routine(int x) {}",
  "int main() {",
  "  Widget item;",
  ...Array.from({ length: MISSPELLED }, (_, index) => `  FuncCallNormalizeRoutine(${index});`),
  "  call_normalize_routine(99);",
  "}",
  "",
].join("\n");
const REAL_CALL_LINE = 7 + MISSPELLED;

async function run(
  cwd: string,
  testName: string,
  calls: { name: string; arguments: Record<string, unknown> }[],
) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, "main.cpp"), SOURCE);
  return new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["read", "replace", "lsp_search"],
    conversation: [
      ...calls.map((call, index) =>
        assistantMessage([toolCall({ id: `call-${index}`, ...call })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done.")]),
    ],
  }).run("Inspect and rename call_normalize_routine");
}

function output(result: Awaited<ReturnType<typeof run>>, index: number): string {
  const id = `call-${index}`;
  const value = getToolResultText(result, id);
  expect(getToolExecution(result, id).isError, value).toBe(false);
  return value;
}

test("symbol search and the calls view list only places that name the function", async () => {
  await withTempWorkspace(async (cwd) => {
    // The calls view goes first: clangd answers symbol searches from an index it fills after
    // parsing the opened file.
    const result = await run(cwd, "corrected-names-search", [
      { name: "lsp_search", arguments: { calls: "main.cpp#call_normalize_routine" } },
      { name: "lsp_search", arguments: { query: "call_normalize_routine", path: "main.cpp" } },
      { name: "lsp_search", arguments: { query: "Widget", path: "main.cpp" } },
    ]);
    const graph = output(result, 0);
    expect(graph).toContain(
      `References: 2 in 1 file(s)\n- main.cpp (2)\n  - 4\n  - ${REAL_CALL_LINE}\n`,
    );
    expect(graph).toContain(`Incoming calls: 1\n- Function main — main.cpp ${REAL_CALL_LINE}\n`);

    const lines = (value: string) =>
      [...value.matchAll(/main\.cpp:(\d+):\d+ (?:definition|reference)/gu)].map((hit) =>
        Number(hit[1]),
      );
    expect(lines(output(result, 1))).toEqual([4, REAL_CALL_LINE]);

    // The constructor call at the variable has other text but no error, so it stays listed.
    expect(output(result, 2)).toContain("main.cpp:6:10 reference Widget");
  });
}, 120_000);

test("a symbol rename leaves names the compiler corrected from a misspelling as written", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await run(cwd, "corrected-names-rename", [
      {
        name: "replace",
        arguments: { path: "symbol:main.cpp#call_normalize_routine#name", text: "renamed_routine" },
      },
    ]);
    output(result, 0);
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(
      SOURCE.replaceAll("call_normalize_routine", "renamed_routine"),
    );
  });
}, 120_000);
