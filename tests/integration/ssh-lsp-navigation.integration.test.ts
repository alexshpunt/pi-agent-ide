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
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary scoped SSH symbols and graphs preserve target identities and report server failures", async () => {
  const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
  const base = path.resolve(".tmp/ssh-lsp-navigation");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const project = `${fixture.workspace}/nested`;
  const root = `ssh://fixture${project}`;
  try {
    await backend.write(`${project}/note.ts`, Buffer.from('const label = "café";\n'), null);
    await backend.write(`${project}/reference.ts`, Buffer.from('const label = "second";\n'), null);
    await backend.write(
      `${project}/server.py`,
      await readFile("tests/integration/fixtures/lsp-owner-server.py"),
      null,
    );
    await backend.write(
      `${project}/.pi/pi-agent-ide/lsp-servers.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          servers: {
            owned: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: ["diagnostics"],
              initializationOptions: { ownerExitOnSymbolQuery: "exit" },
            },
          },
        }),
      ),
      null,
    );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: [
          "ide.ast",
          "ide.formatter",
          "ide.lint",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-lsp-navigation",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "read", "codemode"],
      // Nine sequential native queries now publish guarded snapshot targets as well.
      timeoutMs: 90000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "symbols",
            name: "search",
            arguments: { query: "symbols:label", path: root, include: "*.ts", limit: 50 },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "scoped",
            name: "search",
            arguments: {
              query: "symbols:label",
              path: root,
              include: "*.ts",
              exclude: "reference.ts",
              limit: 50,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "graph",
            name: "read",
            arguments: { path: `graph:${root}/note.ts#label` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "broken",
            name: "search",
            arguments: { query: "symbols:broken", path: root, include: "*.ts" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "native",
            name: "codemode",
            arguments: {
              code: `const result = await tools.search({ query: "symbols:label", path: ${JSON.stringify(root)}, include: "*.ts" }); text(result);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "unsupported",
            name: "search",
            arguments: { query: "symbols:unsupported", path: root, include: "*.ts" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "exited",
            name: "search",
            arguments: { query: "symbols:exit", path: root, include: "*.ts" },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "restarted",
            name: "search",
            arguments: { query: "symbols:label", path: root, include: "*.ts" },
          }),
        ]),
        assistantMessage([text("Checked owned symbol and graph navigation.")]),
      ],
    }).run("Query only the configured target project and retain failures.");
    expect(getToolExecution(run, "symbols").isError, getToolResultText(run, "symbols")).toBe(false);
    expect(getToolResultText(run, "symbols")).toContain(`${root}/note.ts`);
    expect(getToolResultText(run, "symbols")).toContain(`${root}/reference.ts`);
    expect(getToolResultText(run, "scoped")).toContain(`${root}/note.ts`);
    expect(getToolResultText(run, "scoped")).not.toContain(`${root}/reference.ts`);
    expect(getToolExecution(run, "graph").isError, getToolResultText(run, "graph")).toBe(false);
    expect(getToolResultText(run, "graph")).toContain("References: 2 in 2 file(s)");
    expect(getToolResultText(run, "graph")).toContain(`${root}/reference.ts`);
    expect(getToolExecution(run, "broken").isError).toBe(true);
    expect(getToolResultText(run, "broken")).toContain("Owned navigation failure");
    expect(getToolExecution(run, "unsupported").isError).toBe(true);
    expect(getToolResultText(run, "unsupported")).toContain("workspace/symbol is unavailable");
    expect(getToolExecution(run, "native").isError, getToolResultText(run, "native")).toBe(false);
    expect(getToolResultText(run, "native")).toContain(`${root}/note.ts`);
    expect(getToolExecution(run, "exited").isError).toBe(true);
    expect(getToolExecution(run, "restarted").isError, getToolResultText(run, "restarted")).toBe(
      false,
    );
    expect(getToolResultText(run, "restarted")).toContain(`${root}/note.ts`);
    expect(run.tuiRenderedOutput).toContain(`${root}/reference.ts`);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);

test("ending a native script cancels an ordinary SSH symbol startup and reaps its server", async () => {
  const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
  const base = path.resolve(".tmp/ssh-lsp-navigation");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "cancel-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const project = `${fixture.workspace}/nested`;
  const root = `ssh://fixture${project}`;
  const marker = `${project}/initialize.pid`;
  try {
    await backend.write(`${project}/note.ts`, Buffer.from('const label = "café";\n'), null);
    await backend.write(
      `${project}/server.py`,
      await readFile("tests/integration/fixtures/lsp-owner-server.py"),
      null,
    );
    await backend.write(
      `${project}/.pi/pi-agent-ide/lsp-servers.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          servers: {
            owned: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: [],
              initializationOptions: { ownerInitializeDelay: 15, ownerInitializeMarker: marker },
            },
          },
        }),
      ),
      null,
    );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: true,
        disabled: ["ide.ast", "ide.formatter", "ide.lint", "ide.debugger", "ide.vision"],
      }),
    );
    const poll =
      "import os,sys,time; p=sys.argv[1]; end=time.monotonic()+10\nwhile not os.path.exists(p) and time.monotonic()<end: time.sleep(.02)\nprint(open(p).read())";
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = `python3 -c ${quote(poll)} ${quote(marker)}`;
    const run = await new PiIntegrationTest({
      testName: "ssh-lsp-script-cancel",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "bash", "delete", "codemode"],
      timeoutMs: 45000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "cancel-startup",
            name: "codemode",
            arguments: {
              code: `const pending = tools.search({ query: "symbols:label", path: ${JSON.stringify(root)}, include: "*.ts" }); pending.catch(() => undefined); const observed = await tools.bash({ command: ${JSON.stringify(command)}, cwd: ${JSON.stringify(root)} }); text(observed); const session = observed.match(/^session: (shell:[^\\s]+)/m)?.[1]; if (!session) throw new Error("Bash did not publish its session"); store("startupPollSession", session);`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "check-reaped",
            name: "codemode",
            arguments: {
              code: `const checked = await tools.bash({ command: ${JSON.stringify(`python3 -c ${quote("import os,sys; pid=open(sys.argv[1]).read().strip(); print(os.path.exists('/proc/'+pid))")} ${quote(marker)}`)}, cwd: ${JSON.stringify(root)} }); text(checked); const session = checked.match(/^session: (shell:[^\\s]+)/m)?.[1]; if (!session) throw new Error("Bash did not publish its session"); await tools.delete({ path: session }); await tools.delete({ path: load("startupPollSession") });`,
            },
          }),
        ]),
        assistantMessage([text("Stopped the abandoned owned startup.")]),
      ],
    }).run("Observe a real pending startup, then leave its native script without waiting for it.");
    expect(
      getToolExecution(run, "cancel-startup").isError,
      getToolResultText(run, "cancel-startup"),
    ).toBe(false);
    expect(getToolResultText(run, "cancel-startup")).toContain("exitCode: 0");
    expect(getToolExecution(run, "check-reaped").isError).toBe(false);
    expect(getToolResultText(run, "check-reaped")).toContain("exitCode: 0");
    expect(getToolResultText(run, "check-reaped")).toContain("False");
    const pid = Number((await backend.read(marker)).bytes.toString("utf8"));
    expect(Number.isSafeInteger(pid)).toBe(true);
    const inspected = await backend.execute(
      "python3",
      ["-c", "import os,sys; print(os.path.exists('/proc/'+sys.argv[1]))", String(pid)],
      project,
    );
    expect(inspected.stdout.toString("utf8").trim()).toBe("False");
    expect(run.tuiRenderedOutput).toContain(root);
  } finally {
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
