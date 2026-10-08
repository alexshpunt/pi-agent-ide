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

test.each(["diagnostics", "rename", "race"] as const)(
  "remote language server protects %s",
  async (mode) => {
    const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
    const base = path.resolve(".tmp/ssh-lsp-tests");
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
    const note = `${root}/note.ts`;
    try {
      await backend.write(`${project}/note.ts`, Buffer.from('const label = "café";\n'), null);
      await backend.write(
        `${project}/reference.ts`,
        Buffer.from('const label = "second";\n'),
        null,
      );
      const futureTimes = await backend.execute(
        "python3",
        [
          "-c",
          "import os,sys,time; t=time.time_ns()+86400000000000; [os.utime(p,ns=(t,t)) for p in sys.argv[1:]]",
          `${project}/note.ts`,
          `${project}/reference.ts`,
        ],
        project,
      );
      expect(futureTimes.exitCode).toBe(0);
      await backend.write(
        `${project}/server.py`,
        await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
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
        testName: `ssh-lsp-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["read", "replace", "write"],
        timeoutMs: 60000,
        conversation: [
          ...(mode === "diagnostics"
            ? [
                assistantMessage([
                  toolCall({
                    id: "start-diagnostics",
                    name: "read",
                    arguments: { path: `diagnostics:${note}` },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "wait-diagnostics",
                    name: "read",
                    arguments: { path: `diagnostics:${note}` },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "diagnostics",
                    name: "read",
                    arguments: { path: `diagnostics:${note}` },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "diagnostic-view",
                    name: "read",
                    arguments: { path: note, views: ["diagnostics"] },
                  }),
                ]),
              ]
            : mode === "rename"
              ? [
                  assistantMessage([
                    toolCall({
                      id: "symbol",
                      name: "read",
                      arguments: { path: `symbol:${note}#label` },
                    }),
                  ]),
                  assistantMessage([
                    toolCall({
                      id: "rename",
                      name: "replace",
                      arguments: { path: `symbol:${note}#label#name`, text: "renamed" },
                    }),
                  ]),
                  assistantMessage([
                    toolCall({ id: "renamed", name: "read", arguments: { path: note } }),
                  ]),
                  assistantMessage([
                    toolCall({
                      id: "reference-renamed",
                      name: "read",
                      arguments: { path: `${root}/reference.ts` },
                    }),
                  ]),
                ]
              : [
                  assistantMessage([
                    toolCall({
                      id: "race",
                      name: "replace",
                      arguments: { path: `symbol:${note}#label#name`, text: "raced" },
                    }),
                  ]),
                ]),
          assistantMessage([text("Verified the owner contract.")]),
        ],
      }).run("Read the configured remote language server diagnostic snapshot.");
      expect(run.tuiRenderedOutput).toContain(note);
      if (mode === "diagnostics") {
        expect(
          getToolExecution(run, "diagnostics").isError,
          getToolResultText(run, "diagnostics"),
        ).toBe(false);
        expect(getToolResultText(run, "diagnostics")).toContain("Owned diagnostic snapshot");
        expect(getToolResultText(run, "diagnostics")).toContain("python3");
        expect(getToolResultText(run, "diagnostics")).toContain("snapshot");
        expect(getToolExecution(run, "diagnostic-view").isError).toBe(false);
        expect(getToolResultText(run, "diagnostic-view")).toContain("Owned diagnostic snapshot");
      } else if (mode === "rename") {
        expect(getToolExecution(run, "symbol").isError, getToolResultText(run, "symbol")).toBe(
          false,
        );
        expect(getToolResultText(run, "symbol")).toContain('const label = "café";');
        expect(getToolExecution(run, "rename").isError, getToolResultText(run, "rename")).toBe(
          false,
        );
        expect(getToolResultText(run, "renamed")).toContain('const renamed = "café";');
        expect(getToolResultText(run, "reference-renamed")).toContain('const renamed = "second";');
      } else {
        expect(getToolExecution(run, "race").isError).toBe(true);
        expect(getToolResultText(run, "race")).toContain("changed during the server request");
      }
      expect((await backend.read(`${project}/note.ts`)).bytes.toString("utf8")).toBe(
        mode === "rename" ? 'const renamed = "café";\n' : 'const label = "café";\n',
      );
      expect((await backend.read(`${project}/reference.ts`)).bytes.toString("utf8")).toBe(
        mode === "race"
          ? 'const external = "keep";\n'
          : mode === "rename"
            ? 'const renamed = "second";\n'
            : 'const label = "second";\n',
      );
    } finally {
      await fixture.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);
