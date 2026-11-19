import { PiIntegrationTest } from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { mkdir, writeFile } from "node:fs/promises";
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

const HEADER = ["#pragma once", "inline int dot_func(int a, int b) { return a * b; }", ""].join(
  "\n",
);
const MAIN = ['#include "lib.h"', "int main() { return dot_func(1, 2); }", ""].join("\n");
// A scratch copy that another session creates, lets clangd index, and deletes.
const COPY = ['#include "lib.h"', "int use_copy() { return dot_func(3, 4); }", ""].join("\n");

test("a call graph and a symbol search keep working after a file clangd indexed is deleted", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, "lib.h"), HEADER);
    await writeFile(path.join(cwd, "main.cpp"), MAIN);
    await writeFile(path.join(cwd, "copy.cpp"), COPY);
    await writeFile(
      path.join(cwd, "compile_commands.json"),
      JSON.stringify(
        ["main.cpp", "copy.cpp"].map((file) => ({
          directory: cwd,
          file: path.join(cwd, file),
          arguments: ["clang++", "-std=c++17", "-c", file],
        })),
      ),
    );
    const calls = [
      // Both files are opened, so clangd indexes the call in the copy.
      { name: "lsp_search", arguments: { calls: "lib.h#dot_func" } },
      { name: "delete", arguments: { path: "copy.cpp" } },
      { name: "lsp_search", arguments: { calls: "lib.h#dot_func" } },
      { name: "lsp_search", arguments: { query: "dot_func", path: "." } },
    ];
    const result = await new PiIntegrationTest({
      testName: "lsp-deleted-files",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      timeoutMs: 110_000,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["lsp_search", "delete"],
      conversation: [
        ...calls.map((call, index) =>
          assistantMessage([toolCall({ id: `call-${index}`, ...call })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Done.")]),
      ],
    }).run("Find the callers of dot_func");
    const output = (index: number) => {
      const id = `call-${index}`;
      const value = getToolResultText(result, id);
      expect(getToolExecution(result, id).isError, value).toBe(false);
      return value;
    };

    expect(output(0)).toContain("copy.cpp");
    output(1);
    const graph = output(2);
    expect(graph).toContain("main.cpp");
    expect(graph).toContain("copy.cpp");
    const search = output(3);
    expect(search).toMatch(/main\.cpp:2:\d+ reference dot_func/u);
  });
}, 120_000);
