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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("real Pi bash selects remote cwd without mapping SSH references to local directories", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-terminal-tool-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.lsp",
          "ide.formatter",
          "ide.lint",
          "ide.changes",
          "ide.diagnostics",
          "ide.debugger",
          "ide.vision",
        ],
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({
        targets: [
          {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          },
        ],
      }),
    );
    const remoteCwd = `ssh://fixture${fixture.workspace}`;
    const run = await new PiIntegrationTest({
      testName: "ssh-terminal-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["bash"],
      timeoutMs: 60_000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "remote-background",
            name: "bash",
            arguments: {
              command:
                "while [ ! -e completion-gate ]; do sleep 0.02; done; printf 'SSH-BACKGROUND-DONE\\n'",
              cwd: remoteCwd,
              background: true,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "remote-bash",
            name: "bash",
            arguments: {
              command:
                "touch completion-gate; sleep 0.4; printf 'REMOTE-CWD\\n'; pwd; test -t 0 && printf 'REMOTE-TTY\\n'",
              cwd: remoteCwd,
            },
          }),
          toolCall({
            id: "unknown-target",
            name: "bash",
            arguments: { command: "printf 'MUST-NOT-RUN\\n'", cwd: "ssh://unknown/tmp" },
          }),
        ]),
        assistantMessage([text("SSH terminal check complete.")]),
      ],
    }).run("Run bash using the configured SSH cwd, then verify an unknown target fails.");
    expect(getToolExecution(run, "remote-bash").isError).toBe(false);
    const output = getToolResultText(run, "remote-bash");
    expect(output).toContain("REMOTE-TTY");
    expect(output).toContain(fixture.workspace);
    expect(output).toContain(remoteCwd);
    expect(getToolExecution(run, "unknown-target").isError).toBe(true);
    expect(getToolResultText(run, "unknown-target")).toContain("UNKNOWN_TARGET");
    expect(run.tuiRenderedOutput).toContain(remoteCwd);
    expect(getToolExecution(run, "remote-background").isError).toBe(false);
    const trace = JSON.stringify(run.traceEvents);
    expect(trace).toContain("terminal-completion");
    expect(trace).toContain("SSH-BACKGROUND-DONE");
    expect(trace).not.toContain("Agent is already processing a prompt");
    expect(run.tuiRenderedOutput).toContain("SSH-BACKGROUND-DONE");
    expect(run.tuiRenderedOutput).not.toContain("Agent is already processing a prompt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await fixture.stop();
  }
});
