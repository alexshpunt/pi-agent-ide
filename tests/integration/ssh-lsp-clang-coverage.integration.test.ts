import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { SshBackend } from "#src/backend/ssh.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

const LIB = [
  "#pragma once",
  "struct Vec3fForm { float x, y, z; };",
  "inline Vec3fForm call_normalize_routine(const Vec3fForm& a) { return a; }",
  "template <class T> struct List { T* data; int n; T* begin() { return data; } T* end() { return data + n; } };",
  "",
].join("\n");
function user(name: string, before: string[]): string {
  return [
    '#include "lib.h"',
    ...before,
    `struct Shape_${name} { List<Vec3fForm> locations; };`,
    `void loop_${name}(Shape_${name} s) { for (auto& p : s.locations) p = call_normalize_routine(p); }`,
    "",
  ].join("\n");
}
// After clang's error limit of 20 the loop in a.cpp would lose its reference; Pi lifts the limit.
const A = user("a", [
  "void broken(Vec3fForm v) {",
  ...Array.from({ length: 30 }, () => "  FuncCallNormalizeRoutine(v);"),
  "}",
]);
const B = user("b", ['#include "does_not_exist.h"']);
const lineOf = (content: string) =>
  content.split("\n").findIndex((line) => line.includes("for (")) + 1;

test("C/C++ references on an SSH target open the files that name the symbol and report fatal errors", async () => {
  const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
  const base = path.resolve(".tmp/ssh-lsp-clang-coverage");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const root = `ssh://fixture${fixture.workspace}`;
  try {
    const files: Record<string, string> = {
      "lib.h": LIB,
      "a.cpp": A,
      "b.cpp": B,
      "compile_commands.json": JSON.stringify(
        ["a.cpp", "b.cpp"].map((file) => ({
          directory: fixture.workspace,
          file,
          arguments: ["clang++", "-std=c++17", "-c", file],
        })),
      ),
    };
    for (const [name, content] of Object.entries(files))
      await backend.write(`${fixture.workspace}/${name}`, Buffer.from(content), null);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: ["ide.ast", "ide.formatter", "ide.lint", "ide.debugger", "ide.diagnostics"],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-lsp-clang-coverage",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["lsp_search", "replace"],
      timeoutMs: 90000,
      conversation: [
        // The calls view goes first: clangd answers symbol searches from an index it fills after
        // parsing the opened file.
        assistantMessage([
          toolCall({
            id: "graph",
            name: "lsp_search",
            arguments: { calls: `${root}/lib.h#call_normalize_routine` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "search",
            name: "lsp_search",
            arguments: {
              query: "call_normalize_routine",
              path: `${root}/lib.h`,
              references: true,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "rename",
            name: "replace",
            arguments: {
              path: `symbol:${root}/lib.h#call_normalize_routine#name`,
              text: "renamed_routine",
            },
          }),
        ]),
        assistantMessage([text("Done.")]),
      ],
    }).run("Find and rename call_normalize_routine on the SSH target.");

    const missing = "b.cpp:2 'does_not_exist.h' file not found";
    const graph = getToolResultText(run, "graph");
    expect(getToolExecution(run, "graph").isError, graph).toBe(false);
    expect(graph).toContain(missing);

    const search = getToolResultText(run, "search");
    expect(getToolExecution(run, "search").isError, search).toBe(false);
    expect(search).toContain(`${root}/a.cpp:${lineOf(A)}:`);
    expect(search).toContain(`${root}/b.cpp:${lineOf(B)}:`);
    expect(search).toContain(missing);
    expect(search).not.toContain("a.cpp:1 ");

    const rename = getToolResultText(run, "rename");
    expect(getToolExecution(run, "rename").isError, rename).toBe(true);
    expect(rename).toContain("LSP rename refused; no edits applied.");
    for (const [name, content] of Object.entries({ "lib.h": LIB, "a.cpp": A, "b.cpp": B }))
      expect((await backend.read(`${fixture.workspace}/${name}`)).bytes.toString("utf8")).toBe(
        content,
      );
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
