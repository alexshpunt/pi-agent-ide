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
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { errorLimitNote } from "../../../../src/plugins/pi-agent-ide-lsp/src/lsp/corrected-names.ts";

// After clang's error limit of 20 it stops instantiating templates. The loop over a container
// type first used after the limit then gets no reference, and clang reports no error there.
function source(misspelled: number): { text: string; loopLine: number } {
  const lines = [
    "struct Vec3fForm { float x, y, z; };",
    "inline Vec3fForm call_normalize_routine(const Vec3fForm& a) { return a; }",
    "template <class T> struct List {",
    "  T* data; int n;",
    "  T* begin() { return data; }",
    "  T* end() { return data + n; }",
    "};",
    "void broken(Vec3fForm v) {",
    ...Array.from({ length: misspelled }, () => "  FuncCallNormalizeRoutine(v);"),
    "}",
    "struct Shape { List<Vec3fForm> locations; };",
    "void normalize_all(Shape s) {",
    "  for (auto& p : s.locations) p = call_normalize_routine(p);",
    "}",
    "",
  ];
  return {
    text: lines.join("\n"),
    loopLine: lines.findIndex((line) => line.includes("for (")) + 1,
  };
}

async function run(
  cwd: string,
  testName: string,
  content: string,
  calls: { name: string; arguments: Record<string, unknown> }[],
) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, "main.cpp"), content);
  return new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["lsp_search"],
    conversation: [
      ...calls.map((call, index) =>
        assistantMessage([toolCall({ id: `call-${index}`, ...call })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done.")]),
    ],
  }).run("Find the calls of call_normalize_routine");
}

function output(result: Awaited<ReturnType<typeof run>>, index: number): string {
  const id = `call-${index}`;
  const value = getToolResultText(result, id);
  expect(getToolExecution(result, id).isError, value).toBe(false);
  return value;
}

// The calls view goes first: clangd answers symbol searches from an index it fills after parsing
// the opened file.
const CALLS = [
  { name: "lsp_search", arguments: { calls: "main.cpp#call_normalize_routine" } },
  { name: "lsp_search", arguments: { query: "call_normalize_routine", path: "main.cpp" } },
];
const NOTE = errorLimitNote(["main.cpp"]);
// A complete result offers an anchor that selects every match.
const ALL_MATCHES = /SEARCH#\w+:all:match/u;

test("references from a file past the compiler's error limit are marked incomplete", async () => {
  await withTempWorkspace(async (cwd) => {
    const { text: content, loopLine } = source(30);
    const result = await run(cwd, "past-error-limit", content, CALLS);

    const graph = output(result, 0);
    expect(graph).toContain(NOTE);

    const search = output(result, 1);
    // clangd misses the loop call; the result says so instead of claiming every reference.
    expect(search).not.toContain(`main.cpp:${loopLine}:`);
    expect(search).toContain(NOTE);
    expect(search).not.toMatch(ALL_MATCHES);
  });
}, 120_000);

test("references from a file within the error limit stay complete", async () => {
  await withTempWorkspace(async (cwd) => {
    const { text: content, loopLine } = source(5);
    const result = await run(cwd, "within-error-limit", content, CALLS);

    expect(output(result, 0)).not.toContain(NOTE);
    const search = output(result, 1);
    expect(search).toContain(`main.cpp:${loopLine}:`);
    expect(search).not.toContain(NOTE);
    expect(search).toMatch(ALL_MATCHES);
  });
}, 120_000);
