import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withDeclarationSelections } from "#integration/support/declaration-selections.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
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
  "float upper(float left, float right);",
  "float upper(float a, float b);",
  "int upper(int a, int b) { return a > b ? a : b; }",
  "float useUpper() { return upper(1.0f, 2.0f) + upper(1, 2); }",
  "",
].join("\n");

async function run(
  cwd: string,
  testName: string,
  calls: { name: string; arguments: Record<string, unknown> }[],
) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, "main.cpp"), SOURCE);
  return new PiIntegrationTest(
    withDeclarationSelections({
      testName,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "replace", "lsp_search", "codemode"],
      conversation: [
        ...calls.map((call, index) =>
          assistantMessage([toolCall({ id: `call-${index}`, ...call })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Done.")]),
      ],
    }),
  ).run("Find and rename one C++ overload");
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
      {
        name: "codemode",
        arguments: {
          code: 'const result = await tools.lsp_search({ calls: "main.cpp#clamp(int, int, int)" }); text(JSON.stringify(result.matches.map(({ line }) => line)));',
        },
      },
      { name: "lsp_search", arguments: { query: "clamp", path: "main.cpp" } },
      { name: "lsp_search", arguments: { declaration: "main.cpp#lerp" } },
      { name: "lsp_search", arguments: { declaration: "main.cpp#clamp" } },
      {
        name: "replace",
        arguments: {
          path: "fixture:declaration:main.cpp#clamp(const Vec&, float, float)#name",
          newText: "clampVec",
        },
      },
    ]);

    // The int prototype, definition and calls, without the Vec call.
    expect(output(result, 0).split("\n")).toContain("[2,6,7,12]");

    output(result, 1);
    const {
      payload: { hits },
    } = getToolExecutionDetails(getToolExecution(result, "call-1")) as {
      payload: {
        hits: {
          role: string;
          lineNumber: number;
          symbol: { selector?: string[]; range: { startLine: number; startColumn: number } };
        }[];
      };
    };
    const definitions = hits
      .filter(({ role }) => role === "definition")
      .map(({ lineNumber, symbol }) => [lineNumber, symbol.selector]);
    expect(definitions).toEqual([
      [6, ["clamp(int, int, int)"]],
      [7, ["clamp(const Vec&, float, float)"]],
    ]);
    expect(
      hits
        .filter(({ role }) => role === "reference")
        .map(({ lineNumber, symbol }) => [
          lineNumber,
          symbol.range.startLine,
          symbol.range.startColumn,
        ]),
    ).toContainEqual([11, 7, 11]);

    expect(output(result, 2)).toContain("return a + (b - a) * t;");

    const ambiguous = output(result, 3, true);
    expect(ambiguous.match(/main\.cpp#clamp\([^)]*\)/gu)).toEqual([
      "main.cpp#clamp(int, int, int)",
      "main.cpp#clamp(const Vec&, float, float)",
    ]);

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

test("one overload can be selected and renamed when its declarations have no local body", async () => {
  await withTempWorkspace(async (cwd) => {
    const declaration = "main.cpp#upper(float, float)";
    const result = await run(cwd, "prototype-only-overload", [
      { name: "lsp_search", arguments: { declaration } },
      {
        name: "replace",
        arguments: {
          path: `fixture:declaration:${declaration}#name`,
          newText: "upperFloat",
        },
      },
    ]);

    expect(output(result, 0)).toContain("float upper(float left, float right);");
    output(result, 1);
    expect(await readFile(path.join(cwd, "main.cpp"), "utf8")).toBe(
      SOURCE.replace("upper(float left", "upperFloat(float left")
        .replace("upper(float a", "upperFloat(float a")
        .replace("upper(1.0f", "upperFloat(1.0f"),
    );
  });
}, 120_000);
