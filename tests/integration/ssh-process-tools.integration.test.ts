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

test("ordinary process search and read keep target PIDs separate from the controller", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-process-tool-tests");
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
  const child = await owner.backend.startProcess(
    "python3",
    ["-c", "import time; time.sleep(60) # process-tool-owned-marker"],
    fixture.workspace,
  );
  const resource = `process:ssh://fixture/${child.pid}`;
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
        ],
      }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [target] }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-process-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "codemode", "bash", "delete"],
      timeoutMs: 60_000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "search",
            name: "search",
            arguments: { query: "process:process-tool-owned-marker", path: scope },
          }),
        ]),
        assistantMessage([toolCall({ id: "read", name: "read", arguments: { path: resource } })]),
        assistantMessage([
          toolCall({
            id: "unknown",
            name: "read",
            arguments: { path: `process:ssh://unknown/${child.pid}` },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `text(await tools.search({query:"process:${child.pid}",path:${JSON.stringify(scope)}}));`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "owned-structured",
            name: "codemode",
            arguments: {
              code: `const child=await tools.bash({command:"exec python3 -c 'import time; time.sleep(60) # native-owned-channel'",cwd:${JSON.stringify(scope)},background:true}); try { if(!child.remote) throw new Error("Missing remote PID"); text(await tools.search({query:"process:"+child.remote.pid,path:${JSON.stringify(scope)}})); } finally { text(await tools.delete({path:child.source})); } const missing=await tools.read({path:"process:ssh://fixture/"+child.remote.pid}); text(missing); if(missing.status!=="error") throw new Error("Closed owned process still readable");`,
            },
          }),
        ]),
        assistantMessage([text("Process identities verified.")]),
      ],
    }).run("Inspect the target process without granting local process ownership.");
    for (const id of ["search", "read"]) {
      expect(getToolExecution(run, id).isError).toBe(false);
      expect(getToolResultText(run, id)).toContain(resource);
      expect(getToolResultText(run, id)).toContain("Owned by Agent IDE: no");
      expect(getToolResultText(run, id)).toContain("Identity:");
    }
    expect(getToolExecution(run, "unknown").isError).toBe(true);
    expect(getToolResultText(run, "unknown")).toContain(
      `UNKNOWN_TARGET: process:ssh://unknown/${child.pid}`,
    );
    expect(getToolExecution(run, "structured").isError).toBe(false);
    const structured = getToolResultText(run, "structured");
    expect(structured).toContain(resource);
    expect(structured).toContain('"owned":false');
    expect(structured).toContain('"identity":');
    expect(structured).toContain('"executable":');
    expect(getToolExecution(run, "owned-structured").isError).toBe(false);
    const owned = getToolResultText(run, "owned-structured");
    expect(owned).toContain('"owned":true');
    expect(owned).toContain('"source":"shell:');
    expect(owned).toContain('"identity":');
    expect(owned).toContain("ENOENT: process:ssh://fixture/");
    expect(run.tuiRenderedOutput).toContain(resource);
    expect(run.tuiRenderedOutput).toContain("Target: fixture");
  } finally {
    await child.stop();
    await fixture.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
