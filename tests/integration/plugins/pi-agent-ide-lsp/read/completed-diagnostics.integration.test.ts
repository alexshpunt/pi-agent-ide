import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "vitest";
import {
  PiIntegrationTest,
  assistantMessage,
  toolCall,
  text,
  getToolExecution,
  getToolResultText,
  testArtifactsDir,
} from "pi-coding-agent-test/base";

for (const mode of ["focused", "view", "combined", "javascript"]) {
  test(`cold ${mode} diagnostics complete before reporting counts`, async () => {
    const root = path.resolve(".agents/tmp/completed-diagnostics");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "project-"));
    const name = mode === "javascript" ? "example.js" : "example.ts";
    const source =
      mode === "javascript"
        ? '/** @type {number} */\nexport const value = "bad";\n'
        : 'export const value: number = "bad";\n';
    const request = {
      path: mode === "focused" ? `diagnostics:${name}` : name,
      ...(mode === "focused"
        ? {}
        : { views: mode === "combined" ? ["anchors", "ast", "diagnostics"] : ["diagnostics"] }),
    };
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    try {
      await writeFile(
        path.join(cwd, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, allowJs: true, checkJs: true },
          include: [name],
        }),
      );
      await writeFile(path.join(cwd, name), source);
      const result = await new PiIntegrationTest({
        testName: `cold-completed-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["read", "replace"],
        conversation: [
          call("first", "read", request),
          call("edit", "replace", { path: name, start: '"bad"', text: "0" }),
          call("clean", "read", { path: `diagnostics:${name}` }),
          assistantMessage([text("Done")]),
        ],
      }).run("Read the first diagnostic report, fix the type error, and read the updated report.");
      for (const id of ["first", "edit", "clean"])
        expect(getToolExecution(result, id).isError).not.toBe(true);
      expect(getToolResultText(result, "first")).toContain("lsp:2322");
      expect(getToolResultText(result, "first")).not.toMatch(
        /lsp: (pending|snapshot|unversioned|unavailable)/u,
      );
      expect(getToolResultText(result, "edit")).not.toMatch(/<!-- lsp:|File diagnostics:/u);
      expect(getToolResultText(result, "clean")).not.toMatch(
        /lsp:2322|lsp: (pending|snapshot|unavailable)/u,
      );
      expect(await readFile(path.join(cwd, name), "utf8")).toContain("= 0;");
      expect(JSON.stringify(result.providerRequests.map((request) => request.messages))).toMatch(
        /File diagnostics:[^}]*lsp 0 error/u,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60000);
}

test("clangd push reports remain usable snapshots without TypeScript commands", async () => {
  const root = path.resolve(".agents/tmp/completed-diagnostics");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "cpp-"));
  try {
    await writeFile(path.join(cwd, "example.cpp"), 'int value = "bad";\n');
    const result = await new PiIntegrationTest({
      testName: "clangd-diagnostic-snapshot",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "cpp", name: "read", arguments: { path: "diagnostics:example.cpp" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the latest C++ diagnostic snapshot without claiming a completed check.");
    expect(getToolExecution(result, "cpp").isError).not.toBe(true);
    const output = getToolResultText(result, "cpp");
    expect(output).toContain("lsp: snapshot");
    expect(output).toContain("completion is unknown");
    expect(output).not.toContain("No diagnostics.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
