import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { JULIA_DEBUG_SOURCE } from "#integration/fixtures/julia-debug-source.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);
const cases = [
  {
    adapter: "julia",
    installed:
      process.env.PI_IDE_JULIA_PATH &&
      process.env.PI_IDE_JULIA_DEBUG_PROJECT &&
      process.env.PI_IDE_JULIA_DEPOT
        ? process.env.PI_IDE_JULIA_PATH
        : undefined,
    file: "note.jl",
    content: JULIA_DEBUG_SOURCE,
    anchor: "    value = value + 1",
    expression: "value",
  },
  {
    adapter: "r",
    installed: process.env.PI_IDE_R_PATH,
    file: "note.R",
    content:
      'run <- function() {\n  value <- 42\n  pid <- Sys.getpid()\n  value <- value + 1\n  cat("café", value, "\\n")\n}\nrun()\n',
    anchor: "  value <- value + 1",
    expression: "value",
  },
  {
    adapter: "debugpy",
    installed: process.env.PI_IDE_DEBUGPY_PACKAGE,
    file: "note.py",
    content: 'label = "café"\nprint(label)\nprint("done")\n',
    anchor: "print(label)",
    expression: "label",
  },
  {
    adapter: "node",
    installed: process.env.PI_IDE_JS_DEBUG,
    file: "note.js",
    content:
      'let value = 42;\nconst pid = process.pid;\nvalue += 1;\nconsole.log("café", value);\n',
    anchor: "value += 1;",
    expression: "value",
  },
] as const;

for (const item of cases) {
  test.skipIf(!item.installed)(
    `ordinary ${item.adapter} debugger tools launch the owned adapter and preserve canonical source frames`,
    async () => {
      const fixture = await startSshFixture(
        {},
        item.adapter === "julia"
          ? {
              PI_JULIA_PATH: item.installed ?? "",
              PI_JULIA_DEBUG_PROJECT: process.env.PI_IDE_JULIA_DEBUG_PROJECT ?? "",
              JULIA_DEPOT_PATH: process.env.PI_IDE_JULIA_DEPOT ?? "",
              JULIA_LOAD_PATH: "@:@stdlib",
              JULIA_NUM_THREADS: "1",
            }
          : item.adapter === "node"
            ? { PI_JS_DEBUG_PATH: item.installed ?? "" }
            : item.adapter === "r"
              ? { PI_R_PATH: item.installed ?? "" }
              : { PYTHONPATH: "{workspace}/packages" },
      );
      const base = path.resolve(".tmp/ssh-debugger-tool-tests");
      await mkdir(base, { recursive: true });
      const cwd = await mkdtemp(path.join(base, "workspace-"));
      const target = {
        id: "fixture",
        host: "fixture",
        workspace: fixture.workspace,
        configFile: fixture.config,
      };
      const registry = new SshBackendRegistry([target]);
      const scope = `ssh://fixture${fixture.workspace}`;
      const owner = registry.resolve(scope);
      if (!owner) throw new Error("Missing owner");
      try {
        if (!item.installed) throw new Error("Missing explicit debugger installation");
        if (item.adapter === "debugpy")
          await cp(item.installed, `${fixture.workspace}/packages/debugpy`, { recursive: true });
        await owner.backend.write(
          `${fixture.workspace}/${item.file}`,
          Buffer.from(item.content),
          null,
        );
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
              "ide.changes",
              "ide.diagnostics",
            ],
          }),
        );
        const source = `${scope}/${item.file}`;
        const code = `const created=await tools.debug({adapter:${JSON.stringify(item.adapter)},program:${JSON.stringify(item.file)},cwd:${JSON.stringify(scope)}}); text(created); if(created.status!=="success"||!created.data) throw new Error("Debugger not configured"); const session=created.data.source; try { text(await tools.read({path:session+"/source",views:["anchors"]})); for(const input of [{path:session+"/source",anchor:${JSON.stringify(item.anchor)},text:"breakpoint"},{path:session,text:"start"},{path:session,text:${JSON.stringify(`evaluate ${item.expression}`)}},{path:session,text:"step over"},{path:session,text:${JSON.stringify(`evaluate ${item.expression}`)}}]) { const result=await tools.insert(input); text(result); if(result.status!=="success") throw new Error("Debug action failed"); } text(await tools.read({path:session})); } finally { text(await tools.delete({path:session})); }`;
        const run = await new PiIntegrationTest({
          testName: `ssh-debugger-tools-${item.adapter}`,
          artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
          cwd,
          rawMode: false,
          isolateUserResources: true,
          extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
          tools: ["debug", "read", "insert", "delete", "codemode"],
          timeoutMs: 60000,
          conversation: [
            assistantMessage([
              toolCall({
                id: "unknown",
                name: "debug",
                arguments: { adapter: item.adapter, program: `ssh://unknown/tmp/${item.file}` },
              }),
            ]),
            assistantMessage([toolCall({ id: "owned", name: "codemode", arguments: { code } })]),
            assistantMessage([text("Owned debugger lifecycle verified.")]),
          ],
        }).run("Use the configured SSH debugger without controller path fallback.");
        expect(getToolExecution(run, "unknown").isError).toBe(true);
        expect(getToolResultText(run, "unknown")).toContain("UNKNOWN_TARGET");
        expect(getToolExecution(run, "owned").isError, getToolResultText(run, "owned")).toBe(false);
        const result = getToolResultText(run, "owned");
        expect(result).toContain(source);
        expect(result).toContain('"status":"stopped"');
        expect(result).toContain('"verified":true');
        expect(result).toContain("café");
        if (item.adapter !== "debugpy") {
          expect(result).toContain('"result":"42"');
          expect(result).toContain('"result":"43"');
          if (item.adapter !== "r") expect(result).toContain("Stop: 2 (step)");
          else {
            // vscDebugger keeps its native breakpoint reason when stepping out of that browser.
            expect(result).toContain("Stop: 2 (breakpoint)");
            expect(result).toContain(`${source}:5`);
          }
        }
        expect(result).toContain('"deleted":true');
        expect(run.tuiRenderedOutput).toContain(source);
        expect(run.tuiRenderedOutput).toContain(item.adapter);
      } finally {
        await fixture.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    70000,
  );
}
