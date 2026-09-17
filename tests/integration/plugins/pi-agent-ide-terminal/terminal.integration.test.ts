import { mkdir, readFile, rm } from "node:fs/promises";
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
import { afterEach, expect, test } from "vitest";

const root = path.resolve();
const workspace = path.join(root, ".agents/tmp/terminal-integration/workspace");
const extension = path.join(root, "src/pi-agent-ide.ts");

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test.runIf(process.platform !== "win32")(
  "runs a real command through the configured shell",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-sync-run",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-terminal",
              name: "bash",
              arguments: { command: "printf 'integration-terminal-ok'" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Terminal command completed.")]),
      ],
    }).run("Run a command in the native terminal session");

    expect(getToolExecution(result, "run-terminal").isError).toBe(false);
    expect(getToolResultText(result, "run-terminal")).toContain("integration-terminal-ok");
    expect(getToolExecutionDetails(getToolExecution(result, "run-terminal"))).toMatchObject({
      status: "completed",
      shell: "Bash",
      exitCode: 0,
    });
    expect(result.tuiRenderedOutput).toContain("completed");
  },
);

test.runIf(process.platform !== "win32")(
  "bounds wait-mode output and preserves the complete log",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-large-wait-output",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      rawMode: false,
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-large-output",
              name: "bash",
              arguments: {
                command: "node -e 'for(let i=1;i<=2100;i++) console.log(\"line-\"+i)'",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Large output completed.")]),
      ],
    }).run("Run a command with large output in wait mode");

    const execution = getToolExecution(result, "run-large-output");
    const details = getToolExecutionDetails(execution) as { readonly fullOutputPath: string };
    const agentText = getToolResultText(result, "run-large-output");
    expect(agentText).not.toContain("line-1\n");
    expect(agentText).toContain("line-2100");
    expect(agentText).toContain("Earlier output omitted");
    expect(agentText).toContain(details.fullOutputPath);
    const fullOutput = await readFile(details.fullOutputPath, "utf8");
    expect(fullOutput).toContain("line-1");
    expect(fullOutput).toContain("line-2100");
    expect(result.tuiRenderedOutput).not.toContain("line-1\n");
    expect(result.tuiRenderedOutput).toContain("line-2100");
    expect(result.tuiRenderedOutput.split("\n").length).toBeLessThan(1_200);
    await rm(details.fullOutputPath, { force: true });
  },
);

test.runIf(process.platform !== "win32")(
  "returns a timed out foreground command as a controllable background session",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-foreground-timeout",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-timeout",
              name: "bash",
              arguments: { command: "sleep 2", timeoutSeconds: 0.1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The command remains available in background.")]),
        assistantMessage([text("The background command completed.")]),
      ],
    }).run("Start a foreground command with a short wait timeout");

    const execution = getToolExecution(result, "run-timeout");
    expect(getToolResultText(result, "run-timeout")).toContain("reason: timeout");
    expect(getToolResultText(result, "run-timeout")).toContain("use write or insert");
    expect(getToolExecutionDetails(execution)).toMatchObject({
      status: "running",
      background: true,
      waitReason: "timeout",
    });
    expect(result.tuiRenderedOutput).toContain("background · timeout");
  },
);

test.runIf(process.platform !== "win32")(
  "disables interactive pagers for synchronous agent commands",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-sync-pager",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-paginated",
              name: "bash",
              arguments: {
                command:
                  "printf old > file; git init -q; git add file; git -c user.name=test -c user.email=test@example.com commit -qm initial; printf new > file; git -c core.pager='sleep 5' --paginate diff; printf pager-ok",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Paginated command completed.")]),
      ],
    }).run("Run a command that would block in an interactive pager");

    expect(getToolResultText(result, "run-paginated")).toContain("pager-ok");
    expect(getToolExecutionDetails(getToolExecution(result, "run-paginated"))).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(
      (getToolExecutionDetails(getToolExecution(result, "run-paginated")) as { elapsedMs: number })
        .elapsedMs,
    ).toBeLessThan(2_000);
  },
);
test.runIf(process.platform !== "win32")(
  "delivers a background completion into a new agent turn",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-background-delivery",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      rawMode: false,
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-background",
              name: "bash",
              arguments: {
                command: "sleep 2.1; printf 'background-terminal-ok'",
                background: true,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("I will continue while it runs.", { delayMs: 350 })]),
        assistantMessage([text("I received the background completion.")]),
      ],
    }).run("Start background terminal work and handle its completion");

    expect(getToolResultText(result, "run-background")).toContain("status: running");
    const trace = JSON.stringify(result.traceEvents);
    expect(trace).toContain("terminal-completion");
    expect(trace).toContain("background-terminal-ok");
    expect(result.providerRequests.length).toBeGreaterThanOrEqual(3);
    expect(result.tuiRenderedOutput).toContain("background-terminal-ok");
  },
);

test.runIf(process.platform !== "win32")(
  "reports a background command timeout as soon as it exits",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-command-timeout-delivery",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions: [extension],
      tools: ["bash"],
      rawMode: false,
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-command-timeout",
              name: "bash",
              arguments: { command: "timeout 2.3 sleep 10", background: true },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The command is running.", { delayMs: 350 })]),
        assistantMessage([text("I received the timeout completion.")]),
      ],
    }).run("Start a background command that times out");

    const trace = JSON.stringify(result.traceEvents);
    expect(trace).toContain("terminal-completion");
    expect(trace).toContain('"completionReason":"timeout"');
    expect(trace).toContain('"exitCode":124');
    expect(result.tuiRenderedOutput).toContain("reason timeout");
  },
);
