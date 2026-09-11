import { mkdir, rm } from "node:fs/promises";
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
      tools: ["run"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-terminal",
              name: "run",
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
      tools: ["run"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-paginated",
              name: "run",
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
      tools: ["run"],
      rawMode: false,
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-background",
              name: "run",
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
