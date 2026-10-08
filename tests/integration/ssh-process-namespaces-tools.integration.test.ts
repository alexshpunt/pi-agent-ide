import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { startSshPidNamespaceFixture } from "#integration/support/ssh-pid-namespace-fixture.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("ordinary process resources and searches separate identical PIDs in two real target namespaces", async () => {
  const left = await startSshPidNamespaceFixture();
  let right: Awaited<ReturnType<typeof startSshPidNamespaceFixture>> | undefined;
  const base = path.resolve(".tmp/ssh-process-namespace-tools");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  try {
    right = await startSshPidNamespaceFixture();
    const targets = [left, right].map((fixture, index) => ({
      id: index === 0 ? "left" : "right",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    }));
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/ssh.json"), JSON.stringify({ targets }));
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
    const run = await new PiIntegrationTest({
      testName: "ssh-process-namespaces-tools",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "search", "codemode"],
      timeoutMs: 40_000,
      conversation: [
        ...targets.flatMap((target) => [
          assistantMessage([
            toolCall({
              id: `read-${target.id}`,
              name: "read",
              arguments: { path: `process:ssh://${target.id}/1` },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: `search-${target.id}`,
              name: "search",
              arguments: { query: "process:1", path: `ssh://${target.id}${target.workspace}` },
            }),
          ]),
        ]),
        assistantMessage([
          toolCall({
            id: "structured",
            name: "codemode",
            arguments: {
              code: `for (const scope of ${JSON.stringify(targets.map((target) => `ssh://${target.id}${target.workspace}`))}) { const result=await tools.search({query:"process:1",path:scope}); if(!result.includes("process:"+scope.split("/").slice(0,3).join("/")+"/1") || !result.includes("Owned by Agent IDE: no")) throw new Error("No target process snapshot: "+result); text(result); }`,
            },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "unconfigured",
            name: "read",
            arguments: { path: "process:ssh://unconfigured/1" },
          }),
        ]),
        assistantMessage([
          text("Identical native PIDs remain separate, read-only target identities."),
        ]),
      ],
    }).run("Inspect PID 1 on both configured targets without treating it as controller-owned.");
    for (const id of ["left", "right"]) {
      for (const kind of ["read", "search"]) {
        const callId = `${kind}-${id}`;
        expect(getToolExecution(run, callId).isError).toBe(false);
        const output = getToolResultText(run, callId);
        expect(output).toContain(`process:ssh://${id}/1`);
        expect(output).toContain(`Target: ${id}`);
        expect(output).toContain("Owned by Agent IDE: no");
        expect(output).toContain("ssh-network-server.py");
        expect(output).not.toContain(`process:ssh://${id === "left" ? "right" : "left"}/1`);
      }
    }
    const structured = getToolResultText(run, "structured");
    expect(getToolExecution(run, "structured").isError).toBe(false);
    expect(structured).toContain("process:ssh://left/1");
    expect(structured).toContain("process:ssh://right/1");
    expect(structured).toContain("Owned by Agent IDE: no");
    expect(getToolExecution(run, "unconfigured").isError).toBe(true);
    expect(getToolResultText(run, "unconfigured")).toContain("UNKNOWN_TARGET");
    expect(run.tuiRenderedOutput).toContain("process:ssh://left/1");
    expect(run.tuiRenderedOutput).toContain("process:ssh://right/1");
  } finally {
    await left.stop();
    await right?.stop();
    await rm(cwd, { recursive: true, force: true });
  }
  for (const fixture of [left, right]) {
    await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    for (const pid of [fixture.serverPid, fixture.controllerPid, fixture.controllerSshdPid])
      await expect(access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
  }
}, 50000);
