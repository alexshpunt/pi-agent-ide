import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

const deadlineMs = 30_000;
const local = "slow-tree";
const first = "first.fixture";
const late = "late.fixture";
const probe = "deadline_walker_probe";
const fixtureDirectory = path.resolve("tests/integration/fixtures");
const rg = path.join(fixtureDirectory, "file-search-deadline-rg.py");

const fileArgs = (target: string) => ({ path: target, pattern: "*.fixture" });

test("slow local and SSH file searches return partial paths, stop their walkers, and let Codemode continue", async () => {
  await withTempWorkspace(async (cwd) => {
    const ssh = await startSshFixture({ rg });
    try {
      const dir = path.join(cwd, ".pi/pi-agent-ide");
      const agentDir = path.join(cwd, ".pi-agent");
      const localRg = path.join(agentDir, "bin/rg");
      const remote = `ssh://fixture${ssh.workspace}`;
      await Promise.all([
        enableNativeCodemode(cwd),
        mkdir(dir, { recursive: true }),
        mkdir(path.dirname(localRg), { recursive: true }),
        mkdir(path.join(cwd, local)),
      ]);
      await Promise.all([
        writeFile(
          path.join(dir, "ssh.json"),
          JSON.stringify({
            targets: [
              { id: "fixture", host: "fixture", workspace: ssh.workspace, configFile: ssh.config },
            ],
          }),
        ),
        writeFile(
          path.join(dir, "extensions.json"),
          JSON.stringify({
            noAnimations: true,
            noPostProcessing: true,
            disabled: ["ide.lsp", "ide.formatter", "ide.lint", "ide.debugger", "ide.diagnostics"],
          }),
        ),
        writeFile(path.join(cwd, local, first), "LOCAL_FIRST\n"),
        writeFile(path.join(ssh.workspace, first), "SSH_FIRST\n", { mode: 0o644 }),
        writeFile(path.join(cwd, local, late), ""),
        writeFile(path.join(ssh.workspace, late), "", { mode: 0o644 }),
        copyFile(rg, localRg),
      ]);
      await chmod(localRg, 0o755);
      const continued = "LOCAL_FIRST";
      const code = `// @options: {"timeout_ms": 50000}
const started = Date.now();
const found = await tools.file_search(${JSON.stringify(fileArgs(remote))});
text("elapsed_ms=" + (Date.now() - started));
if (JSON.stringify(found) !== ${JSON.stringify(JSON.stringify([`${remote}/${first}`]))}) throw Error("Missing partial paths: " + JSON.stringify(found));
const next = await tools.read({path:${JSON.stringify(`${local}/${first}`)}});
if (next?.text?.trim() !== ${JSON.stringify(continued)}) throw Error("Read after timeout did not run");
text(next.text.trim());`;
      const run = await new PiIntegrationTest({
        testName: "file-search-deadline",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        transport: "rpc",
        environment: { PI_CODING_AGENT_DIR: agentDir, FILE_SEARCH_DEADLINE_REMOTE: ssh.workspace },
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.join(fixtureDirectory, "file-search-deadline-probe.ts"),
        ],
        tools: ["file_search", "read", "codemode", probe],
        timeoutMs: 105_000,
        conversation: [
          assistantMessage([
            toolCall({ id: "local", name: "file_search", arguments: fileArgs(local) }),
          ]),
          assistantMessage([
            toolCall({ id: "local-probe", name: probe, arguments: { scope: "local" } }),
          ]),
          assistantMessage([toolCall({ id: "ssh-script", name: "codemode", arguments: { code } })]),
          assistantMessage([
            toolCall({ id: "ssh-probe", name: probe, arguments: { scope: "ssh" } }),
          ]),
          assistantMessage([text("Done")]),
        ],
      }).run(
        "Search a slow local tree directly and a slow SSH tree in Codemode, then read a file.",
      );

      for (const [id, target] of [
        ["local", local],
        ["ssh-script/1", remote],
      ] as const) {
        const call = getToolExecution(run, id);
        expect(call.isError).toBe(true);
        expect(getToolExecutionDetails(call)).toMatchObject({
          code: "TOOL_TIMEOUT",
          tool: "file_search",
          target,
          timeoutMs: deadlineMs,
        });
      }
      const shown = getToolResultText(run, "local");
      expect(shown).toContain(`${local}/${first}`);
      expect(shown).not.toContain(late);
      expect(shown).toMatch(/incomplete|partial/iu);
      const script = getToolResultText(run, "ssh-script");
      expect(getToolExecution(run, "ssh-script").isError, script).toBe(false);
      expect(script).toContain(continued);
      const elapsed = Number(/elapsed_ms=(\d+)/u.exec(script)?.[1]);
      expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 1_000);
      expect(elapsed).toBeLessThan(deadlineMs + 6_000);
      expect(codemodeFailures(script)).toContain(remote);
      expect(codemodeFailures(script)).not.toContain(late);
      expect(codemodeFailures(script)).toMatch(/incomplete|partial/iu);
      for (const id of ["local-probe", "ssh-probe"]) {
        const call = getToolExecution(run, id);
        expect(call.isError, getToolResultText(run, id)).toBe(false);
        expect(getToolExecutionDetails(call)).toMatchObject({ running: false });
      }
      const directProbe = getToolExecutionDetails(getToolExecution(run, "local-probe"));
      if (
        typeof directProbe !== "object" ||
        directProbe === null ||
        !("elapsedSinceSpawnMs" in directProbe)
      )
        throw new Error("Missing walker timing");
      const directElapsed = directProbe.elapsedSinceSpawnMs;
      expect(directElapsed).toBeGreaterThanOrEqual(deadlineMs - 2_000);
      expect(directElapsed).toBeLessThan(deadlineMs + 6_000);
    } finally {
      await ssh.stop();
    }
  });
}, 120_000);
