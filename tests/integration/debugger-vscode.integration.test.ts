import { writeFile } from "node:fs/promises";
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
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("debug falls back to native adapters when VS Code does not have the workspace open", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "example.py"), "value = 42\nprint(value)\n");
    const calls = {
      vscode: { backend: "vscode", program: "example.py" },
      missingAdapter: { program: "example.py" },
      configuration: { adapter: "debugpy", program: "example.py", configuration: "Run" },
      nativeTest: { backend: "native", adapter: "debugpy", program: "example.py", test: "t" },
      auto: { adapter: "debugpy", program: "example.py" },
    };
    const run = await new PiIntegrationTest({
      testName: "debug-vscode-fallback",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["debug"],
      conversation: [
        assistantMessage(
          Object.entries(calls).map(([id, arguments_]) =>
            toolCall({ id, name: "debug", arguments: arguments_ }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create debugger sessions with each backend choice");

    const unavailable = "No running VS Code window with DebugMCP has";
    expect(getToolExecution(run, "vscode").isError).toBe(true);
    expect(getToolResultText(run, "vscode")).toContain(
      `VS Code backend unavailable: ${unavailable}`,
    );
    expect(getToolExecution(run, "missingAdapter").isError).toBe(true);
    expect(getToolResultText(run, "missingAdapter")).toContain(unavailable);
    expect(getToolExecution(run, "configuration").isError).toBe(true);
    expect(getToolResultText(run, "configuration")).toContain("VS Code backend unavailable");
    expect(getToolExecution(run, "nativeTest").isError).toBe(true);
    expect(getToolResultText(run, "nativeTest")).toContain(
      "configuration and test need the VS Code backend",
    );
    expect(getToolExecution(run, "auto").isError).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(run, "auto"))).toMatchObject({
      adapter: "debugpy",
      status: "configured",
    });
  });
});
