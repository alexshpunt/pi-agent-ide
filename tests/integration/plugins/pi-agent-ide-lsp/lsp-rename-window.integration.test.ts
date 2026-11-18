import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withDeclarationSelections } from "#integration/support/declaration-selections.ts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const SOURCE = 'export function greet() { return "greet"; }\n';
const USAGE = 'import { greet } from "./source";\nexport const answer = greet();\n';

const OVERLOADS = `struct Vec { int x; };
int normalize(int v) { return v; }
int normalize(const Vec& v) { return v.x; }
int main() {
  auto argument = Vec{2};
  return normalize(1) + normalize(argument);
}
`;

const RAW_LITERAL = `[] { if constexpr (sizeof(R"(\n// x\n)") < 10) return Vec{2}; else return 2; }()`;
const LITERAL_OVERLOADS = OVERLOADS.replace("Vec{2}", RAW_LITERAL);
const COLUMN_OVERLOADS = OVERLOADS.replace(
  "int main() {\n  auto argument = Vec{2};",
  `template <bool> struct Arg { using Type = int; };
template <> struct Arg<true> { using Type = Vec; };
#include "argument.h"
auto choose() {
  return ARG;
}
int main() {
  auto argument = choose();`,
);
const RENAMED_OVERLOADS = OVERLOADS.replace(
  "normalize(const Vec&",
  "normalizeVec(const Vec&",
).replace("normalize(argument)", "normalizeVec(argument)");

function additionalCalls(indent: string, vecName: string): string {
  return Array.from(
    { length: 109 },
    (_, index) =>
      `int caller${index}() {\n${indent}return normalize(${index}) + ${vecName}(Vec{${index}});\n}\n`,
  ).join("");
}

async function renameOverload(
  cwd: string,
  mode:
    | "write"
    | "indent"
    | "column"
    | "stall"
    | "binding"
    | "lookup"
    | "literal"
    | "replan"
    | "exhaust",
) {
  const file = path.join(cwd, "main.cpp");
  let source = OVERLOADS;
  if (mode === "literal") source = LITERAL_OVERLOADS;
  if (mode === "column") {
    source = COLUMN_OVERLOADS;
    await writeFile(
      path.join(cwd, "argument.h"),
      "#define ARG Arg<(__builtin_COLUMN() < 11)>::Type{}\n",
    );
  }
  if (mode === "lookup")
    source = OVERLOADS.replace("  auto argument", "  int scalar = 3;\n  auto argument");
  if (mode === "indent") source += additionalCalls("  ", "normalize");
  await writeFile(file, source);
  await writeFile(path.join(cwd, "compile_flags.txt"), "-std=c++17\n");
  await mkdir(path.join(cwd, ".tmp/edit-window"), { recursive: true });
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/lsp-servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        clangd: {
          command: [
            process.execPath,
            path.resolve("tests/integration/fixtures/clangd-rename-window.mjs"),
            mode,
          ],
          transport: "stdio",
          rootMarkers: [],
          languages: { cpp: { extensions: [".cpp"] } },
          capabilities: ["diagnostics"],
        },
      },
    }),
  );
  if (mode === "write")
    await writeFile(
      path.join(cwd, ".tmp/edit-window/write.json"),
      JSON.stringify({ file: "main.cpp", prepend: "// after plan\n", repeat: true }),
    );
  const declaration = "main.cpp#normalize(const Vec&)";
  const rename = (id: string) =>
    assistantMessage(
      [
        toolCall({
          id,
          name: "replace",
          arguments: {
            path: { id: `fixture:declaration:${declaration}#name` },
            text: "normalizeVec",
          },
        }),
      ],
      { stopReason: "toolUse" },
    );
  const run = await new PiIntegrationTest(
    withDeclarationSelections({
      testName: `lsp-rename-window-clang-${mode}`,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/write-in-edit-window.ts"),
      ],
      tools: ["replace"],
      timeoutMs: 45_000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "select", name: "lsp_search", arguments: { declaration } })],
          { stopReason: "toolUse" },
        ),
        rename("rename"),
        ...(mode === "stall" || mode === "exhaust" ? [rename("repeat")] : []),
        assistantMessage([text("Done.")]),
      ],
    }),
  ).run("Rename only the Vec overload while a peer writes the file.");
  return {
    run,
    content: await readFile(file, "utf8"),
    events: (await readFile(path.join(cwd, ".tmp/rename-requests"), "utf8")).trim().split("\n"),
  };
}

test("an exact clangd overload rename survives writes before the server replies and before the edit", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "write");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(events).toEqual(["rename"]);
    expect(content).toBe("// after plan\n" + RENAMED_OVERLOADS + "// during rename\n");
  });
}, 50_000);

test("one overload rename carries 111 edits through line shifts and reindentation", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "indent");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(content).toBe(
      "// peer formatted\n" +
        RENAMED_OVERLOADS.replace("  return normalize(1)", "    return normalize(1)") +
        additionalCalls("    ", "normalizeVec"),
    );
    expect(events).toEqual(["rename"]);
  });
}, 50_000);

test("reindentation refreshes a binding that depends on the column of a header macro", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "column");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(content).toBe(
      COLUMN_OVERLOADS.replace("  return ARG;", "    return ARG;").replace(
        "normalize(const Vec&",
        "normalizeVec(const Vec&",
      ),
    );
    expect(events).toEqual(["rename", "rename"]);
  });
}, 50_000);

test("switching to a differently typed local refreshes the binding of an unchanged call token", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "lookup");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(events).toEqual(["rename", "rename"]);
    expect(content).toBe(
      OVERLOADS.replace("  auto argument", "  int scalar = 3;\n  auto argument")
        .replace("normalize(argument)", "normalize(scalar)")
        .replace("normalize(const Vec&", "normalizeVec(const Vec&"),
    );
  });
}, 50_000);

test("one overload rename includes references added during two consecutive native requests", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "replan");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(events).toEqual(["rename", "rename", "rename"]);
    expect(content).toBe(
      RENAMED_OVERLOADS +
        "int added1() { return normalizeVec(Vec{1}); }\n" +
        "int added2() { return normalizeVec(Vec{2}); }\n",
    );
  });
}, 50_000);

test("three stale refreshes exhaust the rename and leave the selection usable for an immediate repeat", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "exhaust");
    expect(getToolExecution(run, "rename").isError).toBe(true);
    expect(getToolExecution(run, "repeat").isError, getToolResultText(run, "repeat")).toBe(false);
    expect(events).toEqual(Array(5).fill("rename"));
    expect(content).toBe(
      RENAMED_OVERLOADS +
        [1, 2, 3, 4].map((i) => `int added${i}() { return normalizeVec(Vec{${i}}); }\n`).join(""),
    );
  });
}, 50_000);

test("rename refreshes share a deadline, and an immediate repeat cancels without writing", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "stall");
    expect(getToolExecution(run, "rename").isError).toBe(true);
    expect(getToolExecution(run, "repeat").isError).toBe(true);
    expect(events).toEqual(["rename", "rename", "rename", "cancel", "rename", "cancel"]);
    expect(content).toBe(
      OVERLOADS +
        [1, 2, 3].map((i) => `int added${i}() { return normalize(Vec{${i}}); }\n`).join(""),
    );
  });
}, 50_000);

test("a change to an argument type refreshes the overload binding before renaming", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "binding");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(events).toEqual(["rename", "rename"]);
    expect(content).toBe(
      OVERLOADS.replace("Vec{2}", "2").replace("normalize(const Vec&", "normalizeVec(const Vec&"),
    );
  });
}, 50_000);

test("a comment-like line in a raw literal does not reuse the old overload binding", async () => {
  await withTempWorkspace(async (cwd) => {
    const { run, content, events } = await renameOverload(cwd, "literal");
    expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(false);
    expect(events).toEqual(["rename", "rename"]);
    expect(content).toBe(
      LITERAL_OVERLOADS.replace("// x", "// a longer raw string").replace(
        "normalize(const Vec&",
        "normalizeVec(const Vec&",
      ),
    );
  });
}, 50_000);
/**
 * Rename `greet` through the TypeScript language server while another session writes `file`
 * once, after the rename is planned and before it is written.
 */
async function renameInWindow(
  cwd: string,
  testName: string,
  write: { file: string; prepend?: string; append?: string; replace?: [string, string] },
) {
  await mkdir(path.join(cwd, ".tmp/edit-window"), { recursive: true });
  await writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await writeFile(path.join(cwd, "source.ts"), SOURCE);
  await writeFile(path.join(cwd, "usage.ts"), USAGE);
  await writeFile(path.join(cwd, ".tmp/edit-window/write.json"), JSON.stringify(write));
  const run = await new PiIntegrationTest(
    withDeclarationSelections({
      testName,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/write-in-edit-window.ts"),
      ],
      tools: ["replace"],
      timeoutMs: 120_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "rename",
              name: "replace",
              arguments: { path: "fixture:declaration:source.ts#greet#name", text: "welcome" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done.")]),
      ],
    }),
  ).run("Rename greet while another session writes a participant");
  const afterPlan = await access(path.join(cwd, ".tmp/edit-window/after-plan")).then(
    () => true,
    () => false,
  );
  return {
    output: getToolResultText(run, "rename"),
    isError: getToolExecution(run, "rename").isError,
    afterPlan,
    source: await readFile(path.join(cwd, "source.ts"), "utf8"),
    usage: await readFile(path.join(cwd, "usage.ts"), "utf8"),
  };
}

test("a rename succeeds when another session adds lines to a participant after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-prepend", {
      file: "usage.ts",
      prepend: "// peer one\n// peer two\n",
    });

    expect(result.isError, result.output).toBe(false);
    expect(result.afterPlan).toBe(true);
    expect(result.source).toBe('export function welcome() { return "greet"; }\n');
    expect(result.usage).toBe(
      '// peer one\n// peer two\nimport { welcome } from "./source";\nexport const answer = welcome();\n',
    );
  });
});

test("a rename also renames a reference that another session added after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-new-reference", {
      file: "usage.ts",
      append: "export const again = greet();\n",
    });

    expect(result.isError, result.output).toBe(false);
    expect(result.afterPlan).toBe(true);
    expect(result.usage).toBe(
      'import { welcome } from "./source";\nexport const answer = welcome();\nexport const again = welcome();\n',
    );
  });
});

test("a rename writes nothing when another session renamed the symbol after its plan", async () => {
  await withTempWorkspace(async (cwd) => {
    const result = await renameInWindow(cwd, "lsp-rename-window-symbol-gone", {
      file: "source.ts",
      replace: ["function greet", "function hello"],
    });

    expect(result.isError).toBe(true);
    expect(result.afterPlan).toBe(true);
    expect(result.source).toBe('export function hello() { return "greet"; }\n');
    expect(result.usage).toBe(USAGE);
  });
});
