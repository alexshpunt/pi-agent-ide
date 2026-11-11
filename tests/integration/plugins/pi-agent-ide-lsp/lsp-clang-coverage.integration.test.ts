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
import { MAX_OPENED_FILES } from "#src/plugins/pi-agent-ide-lsp/src/lsp/clang-coverage.ts";

// After a fatal clang error, such as a missing #include, clang stops instantiating templates. The
// loop over a container type first used after it then has no reference in clangd's background
// index, and clang reports no error there.
const LIB = [
  "#pragma once",
  "struct Vec3fForm { float x, y, z; };",
  "inline Vec3fForm call_normalize_routine(const Vec3fForm& a) { return a; }",
  "template <class T> struct List {",
  "  T* data; int n;",
  "  T* begin() { return data; }",
  "  T* end() { return data + n; }",
  "};",
  "",
].join("\n");
const LOOP_LINE = 4;
function user(name: string, missingInclude: boolean): string {
  return [
    '#include "lib.h"',
    missingInclude ? '#include "does_not_exist.h"' : "// no other include",
    `struct Shape_${name} { List<Vec3fForm> locations; };`,
    `void loop_${name}(Shape_${name} s) { for (auto& p : s.locations) p = call_normalize_routine(p); }`,
    `void plain_${name}(Vec3fForm v) { v = call_normalize_routine(v); }`,
    "",
  ].join("\n");
}

async function workspace(cwd: string, files: Record<string, string>): Promise<void> {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(cwd, name), content);
  const sources = Object.keys(files).filter((name) => name.endsWith(".cpp"));
  await writeFile(
    path.join(cwd, "compile_commands.json"),
    JSON.stringify(
      sources.map((file) => ({
        directory: cwd,
        file,
        arguments: ["clang++", "-std=c++17", "-c", file],
      })),
    ),
  );
}

async function run(
  cwd: string,
  testName: string,
  calls: { name: string; arguments: Record<string, unknown> }[],
) {
  return new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    rawMode: false,
    extensions: [path.resolve("src/pi-agent-ide.ts")],
    tools: ["lsp_search", "replace"],
    conversation: [
      ...calls.map((call, index) =>
        assistantMessage([toolCall({ id: `call-${index}`, ...call })], { stopReason: "toolUse" }),
      ),
      assistantMessage([text("Done.")]),
    ],
  }).run("Find and rename call_normalize_routine");
}

function output(result: Awaited<ReturnType<typeof run>>, index: number, error = false): string {
  const id = `call-${index}`;
  const value = getToolResultText(result, id);
  expect(getToolExecution(result, id).isError, value).toBe(error);
  return value;
}

// The calls view goes first: clangd answers symbol searches from an index it fills after parsing
// the opened file.
const GRAPH = { name: "lsp_search", arguments: { calls: "lib.h#call_normalize_routine" } };
const SEARCH = {
  name: "lsp_search",
  arguments: { query: "call_normalize_routine", path: "lib.h", references: true },
};
const RENAME = {
  name: "replace",
  arguments: { path: "symbol:lib.h#call_normalize_routine#name", text: "renamed_routine" },
};
const ALL_MATCHES = /SEARCH#\w+:all:match/u;
const MISSING = "b.cpp:2 'does_not_exist.h' file not found";

test("a fatal error in a file the server has not opened marks references incomplete", async () => {
  await withTempWorkspace(async (cwd) => {
    await workspace(cwd, { "lib.h": LIB, "a.cpp": user("a", false), "b.cpp": user("b", true) });
    const result = await run(cwd, "fatal-unopened", [GRAPH, SEARCH, RENAME]);

    const graph = output(result, 0);
    expect(graph).toContain(MISSING);
    expect(graph).toContain("Incomplete: clang stopped with a fatal error");

    // Opened, b.cpp is parsed again and keeps its loop call; the result still says what can miss.
    const search = output(result, 1);
    expect(search).toContain(`b.cpp:${LOOP_LINE}:`);
    expect(search).toContain(`a.cpp:${LOOP_LINE}:`);
    expect(search).toContain(MISSING);
    expect(search).not.toMatch(ALL_MATCHES);

    const rename = output(result, 2, true);
    expect(rename).toContain("LSP rename refused; no edits applied.");
    expect(rename).toContain(MISSING);
    expect(await readFile(path.join(cwd, "lib.h"), "utf8")).toBe(LIB);
    expect(await readFile(path.join(cwd, "b.cpp"), "utf8")).toBe(user("b", true));
  });
}, 180_000);

test("a rename reaches the calls in files the server has not opened", async () => {
  await withTempWorkspace(async (cwd) => {
    await workspace(cwd, { "lib.h": LIB, "a.cpp": user("a", false), "b.cpp": user("b", false) });
    const result = await run(cwd, "rename-unopened", [GRAPH, SEARCH, RENAME]);

    expect(output(result, 0)).not.toContain("Incomplete:");
    const search = output(result, 1);
    expect(search).toContain(`b.cpp:${LOOP_LINE}:`);
    expect(search).toMatch(ALL_MATCHES);
    output(result, 2);
    for (const file of ["a.cpp", "b.cpp"]) {
      const content = await readFile(path.join(cwd, file), "utf8");
      expect(content).not.toContain("call_normalize_routine");
      expect(content.match(/renamed_routine\(/gu)).toHaveLength(2);
    }
  });
}, 180_000);

test("files beyond the opening limit are counted as not checked", async () => {
  await withTempWorkspace(async (cwd) => {
    const extra = MAX_OPENED_FILES + 2;
    const files: Record<string, string> = { "lib.h": LIB };
    for (let index = 0; index < extra; index++)
      files[`c${String(index).padStart(2, "0")}.cpp`] = user(`c${index}`, false);
    await workspace(cwd, files);
    const result = await run(cwd, "opening-limit", [GRAPH, SEARCH, RENAME]);

    expect(output(result, 0)).toContain("Incomplete: 2 more file(s) contain the name");
    const search = output(result, 1);
    expect(search).toContain("Incomplete: 2 more file(s) contain the name");
    expect(search).not.toMatch(ALL_MATCHES);
    expect(output(result, 2, true)).toContain("2 more file(s) contain the name");
  });
}, 300_000);
