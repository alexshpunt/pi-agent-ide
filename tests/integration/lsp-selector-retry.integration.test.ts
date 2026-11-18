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
import { withTextResultChecks } from "#integration/support/text-result-checks.ts";

const DECLARATION = "int normalize(const Vec& v) { return v.x; }";
const SOURCE = [
  "struct Vec { int x; };",
  "int normalize(int v) { return v; }",
  DECLARATION,
  "int vec_caller() { return normalize(Vec{2}); }",
  "int int_caller() { return normalize(1); }",
  "",
].join("\n");

const SELECTOR = "main.cpp#normalize(const Vec&)";
const scripts = {
  calls: `
const result = await tools.lsp_search({ calls: ${JSON.stringify(SELECTOR)} });
check(JSON.stringify(result.matches.map((match) => match.line)) === "[3,4]", "Wrong references");
check(JSON.stringify(result.incoming.map((match) => match.line)) === "[4]", "Wrong callers");
text("Done.");
`,
  declaration: `
const result = await tools.lsp_search({ declaration: ${JSON.stringify(SELECTOR)} });
check(result.matches.length === 1 && result.matches[0].text === ${JSON.stringify(DECLARATION + "\n")}, "Wrong declaration");
text("Done.");
`,
};

test.each(["calls", "declaration"] as const)(
  "lsp_search %s resolves the exact overload after a partial clangd outline",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      const file = path.join(cwd, "main.cpp");
      await writeFile(file, SOURCE);
      await writeFile(path.join(cwd, "compile_flags.txt"), "-std=c++17\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/lsp-servers.json"),
        JSON.stringify({
          version: 1,
          servers: {
            clangd: {
              command: [
                process.execPath,
                path.resolve("tests/integration/fixtures/clangd-outline-window.mjs"),
              ],
              transport: "stdio",
              rootMarkers: [],
              languages: { cpp: { extensions: [".cpp"] } },
              capabilities: ["diagnostics"],
            },
          },
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `lsp-selector-retry-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        rawMode: false,
        traceToolDetails: false,
        timeoutMs: 40_000,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["lsp_search", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: mode,
                name: "codemode",
                arguments: { code: withTextResultChecks(scripts[mode]) },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done.")]),
        ],
      }).run("Navigate to the Vec overload while another writer edits the file.");
      expect(await readFile(file, "utf8")).toBe(SOURCE + "// peer write\n");
      expect(getToolExecution(run, mode).isError, getToolResultText(run, mode)).toBe(false);
    });
  },
  50_000,
);
