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

// Each function has a prototype and a definition, which clangd lists as two document symbols
// with one signature; `clamp` also has two overloads.
const SOURCE = [
  "struct Vec { float x, y; };",
  "inline int clamp(int v, int lo, int hi);",
  "inline Vec clamp(const Vec& v, float lo, float hi);",
  "inline float lerp(float a, float b, float t);",
  "",
  "inline int clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }",
  "inline Vec clamp(const Vec& v, float lo, float hi) { return {static_cast<float>(clamp(static_cast<int>(v.x), 0, 1)), v.y}; }",
  "inline float lerp(float a, float b, float t) { return a + (b - a) * t; }",
  "",
  "int main() {",
  "  Vec v = clamp(Vec{1, 2}, 0.0f, 1.0f);",
  "  return clamp(3, 0, 2) + static_cast<int>(lerp(v.x, v.y, 0.5f));",
  "}",
  "",
].join("\n");

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
  }).run("Find and rename one overload of clamp");
}

function output(result: Awaited<ReturnType<typeof run>>, index: number, failed = false): string {
  const id = `call-${index}`;
  const value = getToolResultText(result, id);
  expect(getToolExecution(result, id).isError, value).toBe(failed);
  return value;
}

test("selectors with parameter types find, list and rename one overload", async () => {
  await withTempWorkspace(async (cwd) => {
    // The calls view goes first: clangd answers symbol searches from an index it fills after
    // parsing the opened file.
    const result = await run(cwd, "overload-selectors", [
      { name: "lsp_search", arguments: { calls: "main.cpp#clamp(int, int, int)" } },
      { name: "lsp_search", arguments: { query: "clamp", path: "main.cpp" } },
      { name: "lsp_search", arguments: { declaration: "main.cpp#lerp" } },
      { name: "lsp_search", arguments: { declaration: "main.cpp#clamp" } },
      {
        name: "replace",
        arguments: {
          path: "symbol:main.cpp#clamp(const Vec&, float, float)#name",
          text: "clampVec",
        },
      },
    ]);

    // The prototype, the call in the other overload and the call in main; not the Vec call.
    expect(output(result, 0)).toContain(
      "References: 4 in 1 file(s)\n- main.cpp (4)\n  - 2\n  - 6\n  - 7\n  - 12\n",
    );

    const search = output(result, 1);
    expect(search).toContain(
      "main.cpp:6:12 definition clamp · selector main.cpp#clamp(int, int, int)",
    );
    expect(search).toContain(
      "main.cpp:7:12 definition clamp · selector main.cpp#clamp(const Vec&, float, float)",
    );
    expect(search).toContain("main.cpp:11:11 reference clamp · declared at main.cpp:7:12");

    // A prototype and its definition are one declaration; the selection is the definition.
    const declaration = output(result, 2);
    expect(declaration).toContain("main.cpp:8-8 declaration main.cpp#lerp");
    expect(declaration).toContain("return a + (b - a) * t;");

    expect(output(result, 3, true)).toContain(
      "matches 2 declarations in main.cpp: main.cpp#clamp(int, int, int) (line 2, 6), main.cpp#clamp(const Vec&, float, float) (line 3, 7).",
    );

    output(result, 4);
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(
      SOURCE.replace(
        "inline Vec clamp(const Vec& v, float lo, float hi);",
        "inline Vec clampVec(const Vec& v, float lo, float hi);",
      )
        .replace(
          "inline Vec clamp(const Vec& v, float lo, float hi) {",
          "inline Vec clampVec(const Vec& v, float lo, float hi) {",
        )
        .replace("Vec v = clamp(Vec{1, 2}", "Vec v = clampVec(Vec{1, 2}"),
    );
  });
}, 120_000);
