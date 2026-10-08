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
import { SshBackendRegistry } from "#src/backend/registry.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary and batched Git follow-up loss stays unknown after confirmed text writes", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-git-loss-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  try {
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const scope = `ssh://fixture${fixture.workspace}`;
    const file = `${scope}/loss-owned.txt`;
    const owner = new SshBackendRegistry([target]).resolve(file);
    if (!owner) throw new Error("Missing fixture owner");
    const git = async (args: string[]) => {
      const result = await owner.backend.execute("git", args, fixture.workspace);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString("utf8");
    };
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    const revision = await owner.backend.write(owner.location.path, Buffer.from("before\n"), null);
    await git(["add", "loss-owned.txt"]);
    await git(["commit", "--quiet", "-m", "base"]);
    await owner.backend.write(owner.location.path, Buffer.from("after café\n"), revision);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [target] }),
    );
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
          "ide.diagnostics",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-git-post-write-loss",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/git-post-write-loss.ts"),
        "builtin:codemode",
      ],
      tools: ["restore_with_lost_reply", "write", "read", "codemode"],
      timeoutMs: 90_000,
      conversation: [
        assistantMessage([
          toolCall({ id: "ordinary", name: "restore_with_lost_reply", arguments: { path: file } }),
        ]),
        assistantMessage([
          toolCall({
            id: "reset",
            name: "write",
            arguments: { path: file, content: "after café\n" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "batched",
            name: "codemode",
            arguments: {
              code: `text(await tools.restore_with_lost_reply({path:${JSON.stringify(file)}}));`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "read-restored", name: "read", arguments: { path: file } }),
        ]),
        assistantMessage([text("Verified.")]),
      ],
    }).run(
      "Check truthful outcome reporting when a real Git publication loses its acknowledgement.",
    );
    expect(getToolExecution(run, "ordinary").isError).toBe(true);
    expect(getToolResultText(run, "ordinary")).toContain("OUTCOME_UNKNOWN");
    expect(getToolResultText(run, "ordinary")).toContain("Completed writes:");
    expect(getToolResultText(run, "ordinary")).not.toContain("No file was changed.");
    expect(getToolExecution(run, "batched").isError).toBe(false);
    const output = getToolResultText(run, "batched");
    const payload = output.split("\n").find((line) => line.startsWith('{"status":'));
    if (payload === undefined) throw new Error("Missing structured tool output");
    const result = JSON.parse(payload) as {
      status: string;
      data: { effect: string };
    };
    expect(result).toMatchObject({ status: "error", data: { effect: "unknown" } });
    expect(getToolResultText(run, "read-restored")).toContain("before");
    expect(await git(["show", ":loss-owned.txt"])).toBe("before\n");
    expect((await owner.backend.read(owner.location.path)).bytes.toString("utf8")).toBe("before\n");
    expect(run.tuiRenderedOutput).toContain("Outcome unknown");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await fixture.stop();
  }
}, 120_000);
