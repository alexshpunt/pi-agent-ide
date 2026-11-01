import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { afterAll, expect, test } from "vitest";

import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

// Pi must run in the exact folder that the VS Code window has open.
const restore = forceStandaloneIntegrationFile();
afterAll(restore);

/**
 * Live check against the user's VS Code. Open a folder containing task.py, test_task.py and a
 * "Task with args" launch configuration in VS Code with DebugMCP, then set
 * PI_DEBUGMCP_LIVE_WORKSPACE to that folder.
 */
const liveWorkspace = process.env.PI_DEBUGMCP_LIVE_WORKSPACE ?? "";

test.skipIf(liveWorkspace === "")(
  "doctor reports the VS Code backend in both installation states",
  async () => {
    const doctor = (testName: string, cwd: string, environment: NodeJS.ProcessEnv = {}) =>
      new PiIntegrationTest({
        testName,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: [],
        environment,
        conversation: [assistantMessage([text("Reviewed")])],
        timeoutMs: 120_000,
      }).run("/agent-ide-doctor --no-apply --agent");
    const open = await doctor("doctor-vscode-open", liveWorkspace);
    expect(JSON.stringify(open.messages)).toContain("VS Code backend: available in");

    // An empty home has no VS Code extensions, while the code CLI stays on PATH.
    const home = await mkdtemp(path.join(tmpdir(), "pi-debugmcp-doctor-"));
    try {
      const missing = await doctor("doctor-vscode-missing", home, { HOME: home });
      const transcript = JSON.stringify(missing.messages);
      expect(transcript).toContain("VS Code backend: DebugMCP is not installed");
      expect(transcript).toContain("code --install-extension ozzafar.debugmcpextension");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  300_000,
);

test
  .skipIf(liveWorkspace === "")
  .each(["auto", "native", "args", "configuration", "test", "user-session"] as const)(
  "live VS Code debugger scenario %s",
  async (scenario) => {
    const run = await new PiIntegrationTest({
      testName: `debug-vscode-live-${scenario}`,
      rawMode: false,
      // VS Code can take tens of seconds to launch its debugger on the first start.
      timeoutMs: 200_000,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: liveWorkspace,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/vscode-debugger-fixture.ts"),
      ],
      tools: ["read", "debug", "insert", "delete", "check_vscode_debugger"],
      conversation: [
        assistantMessage(
          [toolCall({ id: "live", name: "check_vscode_debugger", arguments: { scenario } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run(`Check the ${scenario} VS Code debugger scenario`);
    const execution = getToolExecution(run, "live");
    expect(execution.isError, getToolResultText(run, "live")).toBe(false);
    // Keep the observed tool and VS Code states for review beside the run's terminal frames.
    await writeFile(
      path.join(
        testArtifactsDir(import.meta.filename),
        `debug-vscode-live-${scenario}`,
        "details.json",
      ),
      JSON.stringify(getToolExecutionDetails(execution), undefined, 2),
    );
    const steps = getToolExecutionDetails(execution) as Record<
      string,
      {
        readonly isError?: boolean;
        readonly text?: string;
        readonly status?: { status: string };
        readonly breakpoints?: string;
      }
    >;
    if (scenario === "user-session") {
      expect(steps.vscodeRefusal?.isError).toBe(true);
      expect(steps.vscodeRefusal?.text).toContain("already has an active debug session");
      expect(steps.autoFallback?.text).toContain("Adapter: debugpy");
      expect(steps.vscodeAfter?.status?.status).toBe("paused");
      return;
    }
    const expected = {
      auto: { adapter: "vscode", evaluation: "subtotal = 6" },
      native: { adapter: "debugpy", evaluation: "subtotal = 6" },
      args: { adapter: "debugpy", evaluation: "subtotal = 6" },
      configuration: { adapter: "vscode", evaluation: `"['alpha', 'beta']"` },
      test: { adapter: "vscode", evaluation: "result = 18" },
    }[scenario];
    expect(steps.created?.text).toContain(`Adapter: ${expected.adapter}`);
    expect(steps.started?.text).toContain("Stop: 1 (breakpoint)");
    expect(steps.evaluated?.text).toContain(expected.evaluation);
    expect(steps.vscodeStopped?.status?.status).toBe(
      expected.adapter === "vscode" ? "paused" : "no-session",
    );
    // Pi leaves only the user's breakpoint and no debug session behind.
    expect(steps.vscodeAfter?.status?.status).toBe("no-session");
    expect(steps.vscodeAfter?.breakpoints).toBe("Active Breakpoints:\n1. Breakpoint other.py:1\n");
  },
  240_000,
);
