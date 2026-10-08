import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("real Pi reload retains completed local and SSH terminals and their running sibling until explicit deletion", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-terminal-reload-tests");
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
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })]);
    const run = await new PiIntegrationTest({
      testName: "ssh-terminal-reload",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/terminal-reload-extension.ts"),
      ],
      tools: ["bash", "read", "search", "delete"],
      timeoutMs: 60_000,
      conversation: [
        call("local", "bash", { command: "printf 'LOCAL-RETAINED-COMPLETE\\n'" }),
        call("remote", "bash", { command: "printf 'REMOTE-RETAINED-COMPLETE\\n'", cwd: remoteCwd }),
        call("live", "bash", {
          command:
            "printf 'REMOTE-LIVE-START\\n'; while [ ! -e release ]; do sleep 0.02; done; printf 'REMOTE-LIVE-COMPLETE\\n'",
          cwd: remoteCwd,
          background: true,
        }),
        assistantMessage([text("The three terminal sessions are ready for reload.")]),
        call("read-local", "read", { path: "lifecycle:local" }),
        call("read-remote", "read", { path: "lifecycle:remote" }),
        call("read-live", "read", { path: "lifecycle:live" }),
        call("search-retained", "search", {
          query: "REMOTE-RETAINED-COMPLETE",
          path: "lifecycle:remote",
        }),
        call("release", "bash", { command: "touch release; sleep 0.4", cwd: remoteCwd }),
        call("finished-live", "read", { path: "lifecycle:live" }),
        call("delete-local", "delete", { path: "lifecycle:local" }),
        call("delete-remote", "delete", { path: "lifecycle:remote" }),
        call("delete-live", "delete", { path: "lifecycle:live" }),
        call("missing-remote", "read", { path: "lifecycle:remote" }),
        assistantMessage([
          text("Completed sessions survived reload and disappeared only after deletion."),
        ]),
      ],
    }).run("/terminal-lifecycle");
    for (const id of [
      "local",
      "remote",
      "live",
      "read-local",
      "read-remote",
      "read-live",
      "search-retained",
      "finished-live",
      "delete-local",
      "delete-remote",
      "delete-live",
    ])
      expect(getToolExecution(run, id).isError, id).toBe(false);
    expect(getToolResultText(run, "read-local")).toContain("LOCAL-RETAINED-COMPLETE");
    expect(getToolResultText(run, "read-remote")).toContain("REMOTE-RETAINED-COMPLETE");
    expect(getToolResultText(run, "read-remote")).toContain(remoteCwd);
    expect(getToolResultText(run, "read-live")).toContain("status: running");
    expect(getToolResultText(run, "read-live")).toContain("REMOTE-LIVE-START");
    expect(getToolResultText(run, "search-retained")).toContain("REMOTE-RETAINED-COMPLETE");
    expect(getToolResultText(run, "finished-live")).toContain("REMOTE-LIVE-COMPLETE");
    expect(getToolExecution(run, "missing-remote").isError).toBe(true);
    expect(run.tuiRenderedOutput).toContain("REMOTE-RETAINED-COMPLETE");
    expect(await readFile(path.join(cwd, "terminal-reloaded.json"), "utf8")).toBe(
      JSON.stringify({ reason: "reload" }),
    );
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 70000);
