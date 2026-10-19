import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { expect, test } from "vitest";

test.each(["off", "on"])(
  "a streamed Codemode alias keeps native presentation and canonical execution with panels %s",
  async (panels) => {
    await withTempWorkspace(async (cwd) => {
      await writeFile(path.join(cwd, "note.txt"), "NATIVE_ALIAS_READ\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          disabled: ["ide.lsp", "ide.lint"],
          preferences: { "ui.codemode": panels },
        }),
      );
      const code = 'await tools.read({path:"note.txt"}); text("CODEMODE_SCRIPT_OUTPUT");';
      const run = await new PiIntegrationTest({
        testName: `builtin-codemode-alias-${panels}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        piCommand: process.env.PI_COMMAND ?? "/usr/bin/pi",
        rawMode: false,
        cwd,
        isolateUserResources: true,
        timeoutMs: 90_000,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/fixtures/builtin-codemode-alias.ts"),
        ],
        tools: [
          "read",
          "codemode",
          "mcp__fixture__codemode",
          "mcp__foreign__codemode",
          "mcp__nonmatching__codemode",
        ],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "native-alias",
                name: "mcp__fixture__codemode",
                argumentsJson: JSON.stringify({ code }),
                chunks: { kind: "fixed", size: 8 },
                delayMs: 2,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "foreign",
                name: "mcp__foreign__codemode",
                arguments: { code: "unused" },
              }),
              toolCall({
                id: "nonmatching",
                name: "mcp__nonmatching__codemode",
                arguments: { code: "unused" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Use the streamed alias without changing canonical execution or foreign renderers");
      expect(getToolExecution(run, "native-alias").isError).toBe(false);
      expect(getToolResultText(run, "native-alias")).toContain("CODEMODE_SCRIPT_OUTPUT");
      expect(getToolExecutionDetails(getToolExecution(run, "native-alias"))).toHaveProperty(
        "calls.0.name",
        "read",
      );
      const executions = (await readFile(path.join(cwd, "alias-executions.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; id: string; parent?: string });
      expect(executions.filter((call) => call.name === "codemode")).toEqual([
        { name: "codemode", id: "native-alias" },
      ]);
      expect(executions.filter((call) => call.name === "read")).toEqual([
        { name: "read", id: "native-alias/1", parent: "native-alias" },
      ]);
      expect(executions.some((call) => call.name === "mcp__fixture__codemode")).toBe(false);
      expect(run.tuiRenderedOutput).not.toContain("LOCAL_CODEMODE_ALIAS_RENDERER");
      expect(run.tuiRenderedOutput).toContain('text("CODEMODE_SCRIPT_OUTPUT")');
      expect(run.tuiRenderedOutput).toMatch(/read .*note\.txt/u);
      expect(run.tuiRenderedOutput).toMatch(/Took \d/u);
      expect(run.tuiRenderedOutput.includes("NATIVE_ALIAS_READ")).toBe(panels === "on");
      expect(run.tuiRenderedOutput).toContain("FOREIGN_CODEMODE_RENDERER");
      expect(run.tuiRenderedOutput).toContain("NONMATCHING_CODEMODE_RENDERER");
    });
  },
);
