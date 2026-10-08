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
import { SshBackend } from "#src/backend/ssh.js";
import { startSshPrivateDiagnosticFixture } from "./support/ssh-private-diagnostic-fixture.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary and native tools keep private SSH diagnostics out of agent and TUI results without hiding requested application content", async () => {
  const fixture = await startSshPrivateDiagnosticFixture();
  const base = path.resolve(".tmp/ssh-security-tools");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const allowed = { ...fixture.target, id: "allowed", configFile: fixture.config };
  const backend = new SshBackend(allowed);
  const file = `${fixture.workspace}/application.txt`;
  const applicationCanary = "LPT149_REQUESTED_APPLICATION_CONTENT";
  const original = Buffer.from(`Requested café ${applicationCanary}\n`);
  const source = `ssh://${fixture.target.id}${file}`;
  try {
    await backend.write(file, original, null);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [fixture.target, allowed] }),
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
          "ide.changes",
          "ide.diagnostics",
          "ide.debugger",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-private-diagnostics-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "write", "codemode"],
      timeoutMs: 30_000,
      conversation: [
        assistantMessage([
          toolCall({ id: "ordinary-read", name: "read", arguments: { path: source } }),
        ]),
        assistantMessage([
          toolCall({
            id: "ordinary-write",
            name: "write",
            arguments: { path: source, content: "Must not change\n" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "native",
            name: "codemode",
            arguments: {
              code: `text(await tools.read({path:${JSON.stringify(source)}}));text(await tools.write({path:${JSON.stringify(source)},content:"Must not change\\n"}));`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "unknown",
            name: "read",
            arguments: { path: `ssh://not-configured${file}` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "application",
            name: "read",
            arguments: { path: `ssh://allowed${file}` },
          }),
        ]),
        assistantMessage([text("Security boundary checked without retrying refused writes.")]),
      ],
    }).run("Inspect only the configured resources. Do not retry refused operations.");
    expect(getToolExecution(run, "ordinary-read").isError).toBe(true);
    expect(getToolResultText(run, "ordinary-read")).toContain("TRANSPORT_FAILED");
    expect(getToolExecution(run, "ordinary-write").isError).toBe(true);
    expect(getToolResultText(run, "ordinary-write")).toContain("TRANSPORT_FAILED");
    expect(getToolResultText(run, "ordinary-write")).not.toContain("Outcome unknown");
    expect(getToolExecution(run, "native").isError).toBe(false);
    const results = getToolResultText(run, "native")
      .split("\n")
      .filter((line) => line.startsWith('{"status":'))
      .map((line): unknown => JSON.parse(line));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: "error", errors: [{ code: "TRANSPORT_FAILED" }] });
    expect(results[1]).toMatchObject({
      status: "error",
      data: { effect: "not-applied" },
      errors: [{ code: "TRANSPORT_FAILED" }],
    });
    expect(getToolExecution(run, "unknown").isError).toBe(true);
    expect(getToolResultText(run, "unknown")).toContain("UNKNOWN_TARGET");
    expect(getToolExecution(run, "application").isError).toBe(false);
    expect(getToolResultText(run, "application")).toContain(applicationCanary);
    for (const id of ["ordinary-read", "ordinary-write", "native", "unknown", "application"])
      expect(getToolResultText(run, id)).not.toContain(fixture.canary);
    expect(run.tuiRenderedOutput).not.toContain(fixture.canary);
    expect(run.tuiRenderedOutput).not.toContain("Sensitive transport diagnostic");
    expect(run.tuiRenderedOutput).toContain("TRANSPORT_FAILED");
    expect(run.tuiRenderedOutput).toContain(applicationCanary);
    expect(await readFile(file)).toEqual(original);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await fixture.stop();
  }
}, 40_000);
