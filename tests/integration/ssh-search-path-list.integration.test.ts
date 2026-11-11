import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
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

interface Step {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, JsonValue>;
}

const LIB = "#pragma once\ninline int call_normalize_routine(int value) { return value; }\n";
const user = (name: string) =>
  `#include "lib/lib.h"\nint use_${name}() { return call_normalize_routine(1); }\n`;

/** Run `steps` against an SSH target with `lib/`, `a/`, `b/` and `c/`; `root` is its workspace URL. */
async function runOnTarget(name: string, steps: (root: string) => readonly Step[]) {
  const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
  const base = path.resolve(".tmp/ssh-search-path-list");
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
      "lib/lib.h": LIB,
      "a/a.cpp": user("a"),
      "b/b.cpp": user("b"),
      "c/c.cpp": user("c"),
      "compile_commands.json": JSON.stringify(
        ["a/a.cpp", "b/b.cpp", "c/c.cpp"].map((file) => ({
          directory: fixture.workspace,
          file,
          arguments: ["clang++", "-std=c++17", "-I.", "-c", file],
        })),
      ),
    };
    for (const [file, content] of Object.entries(files))
      await backend.write(`${fixture.workspace}/${file}`, Buffer.from(content), null);
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
        disabled: ["ide.formatter", "ide.lint", "ide.debugger", "ide.diagnostics"],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: name,
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["search", "file_search", "ast_search", "lsp_search"],
      timeoutMs: 150000,
      conversation: [
        ...steps(root).map((step) => assistantMessage([toolCall(step)])),
        assistantMessage([text("Done.")]),
      ],
    }).run("Search the listed SSH directories.");
    return { run, root };
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("text, file and AST search take a list of SSH paths as one scope", async () => {
  const { run, root } = await runOnTarget("ssh-search-path-list", (root): Step[] => {
    // b/b.cpp is inside b and is searched once.
    const listed = [`${root}/a`, `${root}/b`, `${root}/b/b.cpp`];
    return [
      { id: "text", name: "search", arguments: { path: listed, query: "call_normalize_routine" } },
      { id: "files", name: "file_search", arguments: { path: listed, pattern: "*.cpp" } },
      {
        id: "ast",
        name: "ast_search",
        arguments: { path: listed, pattern: "call_normalize_routine($$$ARGS)" },
      },
      {
        id: "machines",
        name: "search",
        arguments: { path: [`${root}/a`, "src"], query: "call_normalize_routine" },
      },
    ];
  });
  for (const id of ["text", "files", "ast"])
    expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
  const textOutput = getToolResultText(run, "text");
  expect(textOutput).toContain("2 matches in 2 files");
  expect(textOutput).not.toContain("c.cpp");
  expect(getToolExecutionDetails(getToolExecution(run, "files"))).toMatchObject({
    payload: { files: [`${root}/a/a.cpp`, `${root}/b/b.cpp`], complete: true },
  });
  const astOutput = getToolResultText(run, "ast");
  expect(astOutput.match(/\/[ab]\/[ab]\.cpp:2:/gu), astOutput).toHaveLength(2);
  expect(astOutput).not.toContain("c.cpp");
  expect(getToolExecution(run, "machines").isError).toBe(true);
  expect(getToolResultText(run, "machines")).toContain("must be on one machine");
}, 240000);

test("LSP search takes a list of SSH directories as one scope", async () => {
  const { run, root } = await runOnTarget("ssh-lsp-search-path-list", (root): Step[] => [
    // clangd answers symbol searches from an index it fills after parsing the opened file.
    {
      id: "warm",
      name: "lsp_search",
      arguments: { calls: `${root}/lib/lib.h#call_normalize_routine` },
    },
    {
      id: "lsp",
      name: "lsp_search",
      arguments: { path: [`${root}/a`, `${root}/b`], query: "call_normalize_routine" },
    },
  ]);
  for (const id of ["warm", "lsp"])
    expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
  const lspOutput = getToolResultText(run, "lsp");
  expect(lspOutput).toContain(`${root}/a/a.cpp:2:`);
  expect(lspOutput).toContain(`${root}/b/b.cpp:2:`);
  expect(lspOutput).not.toContain("c.cpp");
}, 240000);
