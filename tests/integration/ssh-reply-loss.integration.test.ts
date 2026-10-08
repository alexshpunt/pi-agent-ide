import path from "node:path";
import { expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { afterAll } from "vitest";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

// The fixture forwards a real SSH worker and drops its output only after it commits.
test("exit 127 without a reply does not prove a remote mutation was rejected", async () => {
  const fixture = await startSshFixture({
    python3: path.resolve("tests/integration/fixtures/ssh-drop-reply.py"),
  });
  try {
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const file = `${fixture.workspace}/drop-owned.txt`;
    const before = await backend.write(file, Buffer.from("before\n"), null);
    const failure: unknown = await backend
      .write(file, Buffer.from("after\n"), before)
      .catch((error: unknown) => error);
    expect((await backend.read(file)).bytes.toString("utf8")).toBe("after\n");
    // The channel observes the command's exit 127, but has no mutation receipt.
    expect(failure).toMatchObject({ code: "REMOTE_OPERATION_FAILED", effect: "unknown" });
    await expect(backend.write(file, Buffer.from("retry\n"), before)).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "not-applied",
    });
    expect((await backend.read(file)).bytes.toString("utf8")).toBe("after\n");
  } finally {
    await fixture.stop();
  }
}, 60_000);

test("ordinary and structured writes keep a committed SSH write unknown after reply loss", async () => {
  const fixture = await startSshFixture({
    python3: path.resolve("tests/integration/fixtures/ssh-drop-reply.py"),
  });
  const base = path.resolve(".tmp/ssh-reply-loss-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  try {
    const target = {
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    };
    const backend = new SshBackend(target);
    const file = `${fixture.workspace}/drop-owned.txt`;
    const source = `ssh://fixture${file}`;
    await backend.write(file, Buffer.from("before\n"), null);
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
      testName: "ssh-committed-write-reply-loss",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["write", "read", "codemode"],
      timeoutMs: 90_000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "ordinary",
            name: "write",
            arguments: { path: source, content: "after\n" },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "read-after", name: "read", arguments: { path: source } }),
        ]),
        assistantMessage([
          toolCall({
            id: "reset",
            name: "write",
            arguments: { path: source, content: "before\n" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `text(await tools.write({path:${JSON.stringify(source)},content:"after\\n"}));`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({ id: "read-final", name: "read", arguments: { path: source } }),
        ]),
        assistantMessage([text("Verified.")]),
      ],
    }).run("Do not retry uncertain writes. Read the owned file to inspect the actual effect.");
    expect(getToolExecution(run, "ordinary").isError).toBe(true);
    expect(getToolResultText(run, "ordinary")).toContain("OUTCOME_UNKNOWN");
    expect(getToolResultText(run, "ordinary")).not.toContain("No file was changed.");
    expect(getToolResultText(run, "ordinary")).toContain("inspect the resource before retrying");
    expect(getToolResultText(run, "ordinary")).not.toContain("rollback failed");
    expect(getToolResultText(run, "read-after")).toContain("after");
    expect(getToolExecution(run, "reset").isError).toBe(false);
    expect(getToolExecution(run, "structured").isError).toBe(false);
    const payload = getToolResultText(run, "structured")
      .split("\n")
      .find((line) => line.startsWith('{"status":'));
    if (payload === undefined) throw new Error("Missing structured output");
    expect(JSON.parse(payload) as unknown).toMatchObject({
      status: "error",
      data: { effect: "unknown" },
    });
    expect(getToolResultText(run, "read-final")).toContain("after");
    expect((await backend.read(file)).bytes.toString("utf8")).toBe("after\n");
    expect(run.tuiRenderedOutput).toContain("Outcome unknown");
    expect(run.tuiRenderedOutput).not.toContain("Not changed · edit failed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await fixture.stop();
  }
}, 120_000);
