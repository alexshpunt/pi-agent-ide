import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { requiredValue } from "pi-agent-invariant";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { forceStandaloneIntegrationFile } from "./support/pi-runtime/standalone.js";

const restoreSharedRunner = forceStandaloneIntegrationFile();
afterAll(restoreSharedRunner);

test("the public Doctor command inspects the selected SSH project and keeps agent rechecks on that owner", async () => {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/ssh-doctor-command-"));
  const fixture = await startSshFixture(
    {},
    { PI_JS_DEBUG_PATH: "{workspace}/adapter.js", DISPLAY: "" },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const backend = requiredValue(registry.resolve(project)).backend;
    await backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from('const label = "café";\n'),
      null,
    );
    await backend.write(
      `${fixture.workspace}/adapter.js`,
      Buffer.from("// Owned native adapter path.\n"),
      null,
    );
    await writeFile(path.join(cwd, "controller.rb"), "puts 'controller only'\n");
    const configDirectory = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "ssh.json"),
      JSON.stringify({
        targets: [
          {
            id: "fixture",
            host: "fixture",
            workspace: fixture.workspace,
            configFile: fixture.config,
          },
          { id: "unused", host: "never-contact.invalid", workspace: "/unused" },
        ],
      }),
    );
    await writeFile(
      path.join(configDirectory, "extensions.json"),
      JSON.stringify({
        disabled: ["ide.formatter", "ide.lint", "ide.lsp"],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-doctor-command-owner",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: [],
      rawMode: false,
      conversation: [assistantMessage([text("Reviewed the selected project")])],
    }).run(`/pi-agent-ide-doctor ${project} --no-apply --agent`);
    const transcript = JSON.stringify(run.messages);
    expect(run.exitCode).toBe(0);
    expect(transcript).toContain(`Project: ${project}`);
    expect(transcript).toContain("Detected: javascript, typescript");
    expect(transcript).toContain(`Project root: ${project}`);
    expect(transcript).toContain("jq is available");
    expect(transcript).toContain("typescript parser loaded");
    expect(transcript).toContain("vscode-js-debug: available");
    expect(transcript).toContain("Native capture readiness is unavailable");
    expect(transcript).toContain(`DESKTOP_UNAVAILABLE: ${project}`);
    expect(run.tuiRenderedOutput).toContain("Target screen capture readiness");
    expect(JSON.stringify(run.traceEvents)).toContain("Doctor recheck after agent setup");
    expect(transcript).not.toContain("Detected: ruby");
    expect(transcript).not.toContain("Project: " + cwd);
    expect(run.tuiRenderedOutput).toContain(project);
    expect(run.tuiRenderedOutput).toContain("Debug adapters");
    await expect(
      backend.stat(`${fixture.workspace}/.pi/pi-agent-ide/formatters.json`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("the public Doctor apply flag writes only its native project config and rechecks private copies", async () => {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/ssh-doctor-apply-"));
  const fixture = await startSshFixture(
    { "owned-doctor": path.resolve("tests/integration/fixtures/doctor-owner-tool.py") },
    {
      HOME: "{workspace}",
      PI_CODING_AGENT_DIR: "{workspace}/.cache/agent",
      PI_IDE_DOCTOR_MARKER: "{workspace}/probe-pids",
    },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const backend = requiredValue(registry.resolve(project)).backend;
    const original = "const value = 42; // café\n";
    await backend.write(`${fixture.workspace}/note.owned`, Buffer.from(original), null);
    const configDirectory = path.join(cwd, ".pi/pi-agent-ide");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "ssh.json"),
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
    await writeFile(
      path.join(configDirectory, "extensions.json"),
      JSON.stringify({
        disabled: [
          "ide.lint",
          "ide.lsp",
          "ide.debugger",
          "ide.ast",
          "ide.changes",
          "search.text",
          "read.web",
          "read.filesystem.jq",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-doctor-command-apply",
      // Three native checks share the existing 60-second scenario budget.
      timeoutMs: 60000,
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/doctor-owner-contribution.ts"),
      ],
      tools: [],
      rawMode: false,
      conversation: [assistantMessage([text("Reviewed the native configuration")])],
    }).run(`/pi-agent-ide-doctor ${project} --apply --agent`);
    expect(run.exitCode).toBe(0);
    const saved: unknown = JSON.parse(
      (await backend.read(`${fixture.workspace}/.pi/pi-agent-ide/formatters.json`)).bytes.toString(
        "utf8",
      ),
    );
    expect(saved).toMatchObject({
      version: 1,
      formatters: {
        owned: {
          extensions: [".owned"],
          run: { command: ["owned-doctor", "format", "{file}"] },
          output: "in-place",
        },
      },
    });
    expect((await backend.read(`${fixture.workspace}/note.owned`)).bytes.toString("utf8")).toBe(
      original,
    );
    await expect(backend.stat(`${fixture.workspace}/.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      backend.stat(`${fixture.workspace}/.cache/agent/extensions/pi-agent-ide/formatters.json`),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const trace = JSON.stringify(run.traceEvents);
    await expect(readFile(path.join(configDirectory, "formatters.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(trace).toContain("owned [project]");
    expect(trace).toContain("probe passed");
    expect(trace).toContain("Doctor recheck after agent setup");
    expect(run.tuiRenderedOutput).toContain(project);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
