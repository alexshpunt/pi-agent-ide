import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { startTargetFixture } from "#integration/support/ssh-target-fixture.ts";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.ts";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.ts";
import { remoteLocation } from "#src/backend/identity.ts";
import { WINDOWS_SSH_JS_DEBUG_PATH } from "#src/plugins/pi-agent-ide-debugger/src/adapter-executables.ts";
import { inspectDebuggerSetup } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.ts";
import { SshBackendRegistry } from "#src/backend/registry.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);
const depsRoot = process.env.PI_SSH_WINDOWS_HELPERS_ROOT;
const cases = [
  {
    adapter: "debugpy",
    extension: "py",
    content: 'value = 42\nvalue += 1\nprint("café", value)\n',
  },
  {
    adapter: "node",
    extension: "js",
    content: 'let value = 42;\nvalue += 1;\nconsole.log("café", value);\n',
  },
] as const;

test.skipIf(!depsRoot).each(cases)(
  "the $adapter debugger stops at a breakpoint in a native Windows SSH workspace",
  async ({ adapter, extension, content }) => {
    if (!depsRoot)
      throw new Error("Set PI_SSH_WINDOWS_HELPERS_ROOT to the target's dependency directory");
    const fixture = await startTargetFixture("windows");
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-windows-debug-"));
    const filename = `debugger ${randomUUID()}.${extension}`;
    const target = { ...fixture.target, workspace: depsRoot };
    const registry = new SshBackendRegistry([target]);
    const root = remoteLocation(target.id, depsRoot, "windows");
    const source = remoteLocation(target.id, `${root.path}/${filename}`, "windows");
    const owner = registry.resolve(root.source);
    if (!owner) throw new Error("Fixture has no SSH owner");
    let version: string | undefined;
    try {
      version = await owner.backend.write(
        source.path,
        Buffer.from(content.replaceAll("\n", "\r\n")),
        null,
      );
      const workspace = await createSshDoctorWorkspace(registry, root.source);
      const languageId = adapter === "node" ? "javascript" : "python";
      const context = {
        workspace,
        cwd: root.source,
        files: [source.source],
        detectedLanguageIds: new Set([languageId]),
        detectedLanguages: new Map([[languageId, [source.source]]]),
        env: { ...workspace.toolPaths },
      };
      const toolId = adapter === "node" ? "vscode-js-debug" : "debugpy";
      const ready = {
        selections: [{ kind: "debugger", languageId, toolId }],
        actions: [],
      };
      expect(await inspectDebuggerSetup(context)).toEqual(ready);
      if (adapter === "node") {
        expect(
          await inspectDebuggerSetup({
            ...context,
            env: { PI_JS_DEBUG_PATH: path.win32.join(depsRoot, WINDOWS_SSH_JS_DEBUG_PATH) },
          }),
        ).toEqual(ready);
      }
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
          disabled: ["ide.ast", "ide.lsp", "ide.formatter", "ide.lint", "ide.diagnostics"],
        }),
      );
      const breakpoint = adapter === "node" ? "value += 1;" : "value += 1";
      const code = `const configured = await tools.debug(${JSON.stringify({ adapter, cwd: root.source, program: filename })});
        const session = /debug:[a-zA-Z0-9-]+/.exec(configured)?.[0];
        if (!session) throw new Error(configured);
        try {
          const source = await tools.read({path: session + '/source', views: ['anchors']});
          text(source.text);
          await tools.insert({path: session + '/source', after: ${JSON.stringify(breakpoint)}, text: 'breakpoint'});
          await tools.insert({path: session, text: 'start'});
          await tools.insert({path: session, text: 'evaluate value'});
          await tools.insert({path: session, text: 'step over'});
          await tools.insert({path: session, text: 'evaluate value'});
        } finally {
          await tools.delete({path: session});
        }`;
      const run = await new PiIntegrationTest({
        testName: `windows-ssh-debugger-${adapter}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["debug", "read", "insert", "delete", "codemode"],
        timeoutMs: 80000,
        conversation: [
          assistantMessage([toolCall({ id: "owned", name: "codemode", arguments: { code } })]),
          assistantMessage([text("The debugger session is closed.")]),
        ],
      }).run("Debug the CRLF program on the configured Windows SSH target.");
      const result = getToolResultText(run, "owned");
      expect(getToolExecution(run, "owned").isError, result).toBe(false);
      expect(result).toContain("café");
      // Semantic mutation details are available in the Pi trace, not the Codemode return value.
      const action = (index: number) => {
        const id = `owned/${index}`;
        const execution = getToolExecution(run, id);
        expect(execution.isError, JSON.stringify(execution.result)).toBe(false);
        return getToolExecutionDetails(execution);
      };
      const stop = (line: number, reason: string) => ({
        status: "stopped",
        stop: { reason, frame: { line, source: { path: source.source } } },
      });
      expect(action(3)).toMatchObject({
        metadata: { semanticAction: { file: source.source, line: 2, verified: false } },
      });
      expect(action(4)).toMatchObject({
        metadata: {
          semanticAction: {
            ...stop(2, "breakpoint"),
            breakpoints: [{ file: source.source, line: 2, verified: true }],
          },
        },
      });
      expect(action(5)).toMatchObject({
        metadata: { semanticAction: { evaluation: { result: "42" } } },
      });
      expect(action(6)).toMatchObject({ metadata: { semanticAction: stop(3, "step") } });
      expect(action(7)).toMatchObject({
        metadata: { semanticAction: { evaluation: { result: "43" } } },
      });
      expect(action(8)).toMatchObject({
        metadata: { semanticAction: { deleted: true, snapshot: { status: "terminated" } } },
      });
      expect(run.tuiRenderedOutput).toContain(encodeURIComponent(filename));
      expect(run.tuiRenderedOutput).toContain(adapter);
    } finally {
      try {
        if (version !== undefined) await owner.backend.remove(source.path, version);
      } finally {
        await fixture.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    }
  },
  100000,
);

test.skipIf(!depsRoot)(
  "the remote Node broker reports an absent js-debug-dap package",
  async () => {
    const fixture = await startTargetFixture("windows");
    const registry = new SshBackendRegistry([fixture.target]);
    const root = remoteLocation(fixture.target.id, fixture.workspace, "windows");
    const program = remoteLocation(root.target, `${root.path}/program.js`, "windows").source;
    try {
      const owner = createSshDebuggerWorkspaceOwner(registry)(root.source);
      if (!owner) throw new Error("Fixture has no SSH owner");
      await expect(
        owner.prepare({
          adapter: "node",
          program,
          sourceFile: program,
          cwd: root.source,
          args: [],
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", effect: "not-applied" });
    } finally {
      await fixture.stop();
    }
  },
  40000,
);
