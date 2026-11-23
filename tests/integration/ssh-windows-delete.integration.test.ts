import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.ts";
import { runOwnedSshCommand } from "#src/backend/owned-command.ts";
import { remotePython, sshWorkerBundle } from "#src/backend/ssh-transport.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import {
  assistantMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

const targets = JSON.parse(process.env.PI_AGENT_IDE_WINDOWS_SSH_TARGETS ?? "[]") as {
  id: string;
  host: string;
  workspace: string;
}[];
const cases = targets.length > 0 ? targets : [{ id: "unconfigured", host: "", workspace: "" }];

test.skipIf(targets.length === 0).each(cases)(
  "$id: small trees delete quickly alone and in parallel without following junctions",
  async ({ id, host, workspace }) => {
    const backend = new SshBackend({ id, host, workspace, os: "windows" });
    const python = async (source: string) => {
      const result = await backend.execute(remotePython(source), [], backend.target.workspace);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const native = await python(`
import os, stat, subprocess, tempfile
from pathlib import Path
root = Path(tempfile.mkdtemp(prefix="pi-ide-delete-"))
(root / "keep").mkdir()
(root / "keep" / "sentinel.txt").write_text("KEEP")
for n in range(11):
    subtree = root / ("tree-%d" % n) / "nested"
    subtree.mkdir(parents=True)
    for j in range(24):
        leaf = subtree / ("leaf[%d].txt" % j)
        leaf.write_text("fixture")
        if j == 0:
            leaf.chmod(stat.S_IREAD)
subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(root / "tree-0" / "junction"),
                str(root / "keep")], check=True, capture_output=True)
print(root.as_posix())
`);
    const root = `/${native}`;
    const base = path.resolve(".tmp/ssh-windows-delete");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({ targets: [backend.target] }),
      );
      const run = await new PiIntegrationTest({
        testName: `ssh-windows-delete-${id}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["delete", "codemode"],
        timeoutMs: 85_000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "delete-trees",
              name: "codemode",
              arguments: {
                code: `
const root = ${JSON.stringify(`ssh://${id}${root}`)};
const remove = index => tools.delete({ path: root + "/tree-" + index });
const start = Date.now();
await remove(0);
const singleMs = Date.now() - start;
if (singleMs < 7000) {
  const batchStart = Date.now();
  await Promise.all(Array.from({ length: 10 }, (_, index) => remove(index + 1)));
  text("DELETE_TIMINGS " + singleMs + " " + (Date.now() - batchStart));
} else {
  text("DELETE_TIMINGS " + singleMs + " -1");
}
`,
              },
            }),
          ]),
          assistantMessage([text("Finished the delete check.")]),
        ],
      }).run("Delete the disposable Windows SSH directories.");
      const output = getToolResultText(run, "delete-trees");
      expect(codemodeFailures(output), output).toBe("");
      const timings = /DELETE_TIMINGS\s+(\d+)\s+(-?\d+)/u.exec(output);
      expect(timings, output).not.toBeNull();
      const singleMs = Number(timings?.[1]);
      const parallelMs = Number(timings?.[2]);
      console.info({ singleMs, parallelMs });
      expect(singleMs).toBeLessThan(7_000);
      expect(parallelMs).toBeGreaterThanOrEqual(0);
      expect(parallelMs).toBeLessThan(7_000);
      expect((await backend.list(root)).map((entry) => entry.name)).toEqual(["keep"]);
      expect((await backend.read(`${root}/keep/sentinel.txt`)).bytes.toString()).toBe("KEEP");
      expect(run.tuiRenderedOutput).toContain(`ssh://${id}`);
    } finally {
      await python(`
import os, shutil, stat
root = ${JSON.stringify(native)}
junction = os.path.join(root, "tree-0", "junction")
if os.path.lexists(junction): os.rmdir(junction)
for directory, _, names in os.walk(root):
    for name in names: os.chmod(os.path.join(directory, name), stat.S_IWRITE)
shutil.rmtree(root)
`);
      await rm(cwd, { recursive: true, force: true });
    }
  },
  110_000,
);
test.skipIf(targets.length === 0).each(cases)(
  "$id: a Windows delete timeout accounts for the removed leaf and remaining directory",
  async ({ id, host, workspace }) => {
    const backend = new SshBackend({ id, host, workspace, os: "windows" });
    const home = backend.target.workspace;
    const setup = await backend.execute(
      remotePython(`
import tempfile
from pathlib import Path
root = Path(tempfile.mkdtemp(prefix="pi-ide-delete-timeout-"))
(root / "nested").mkdir()
(root / "nested" / "leaf.txt").write_text("fixture")
print(root.as_posix())
`),
      [],
      home,
    );
    expect(setup.exitCode, setup.stderr.toString()).toBe(0);
    const native = setup.stdout.toString().trim();
    const root = `/${native}`;
    try {
      const source = `ssh://${id}${root}`;
      const { revision } = await backend.lstat(root);
      // Expire the budget as soon as the native unlink succeeds. This exercises a partial
      // deadline without relying on timer precision, filesystem speed or a large fixture.
      const clock = `
import os, time
leaf = os.path.join(${JSON.stringify(native)}, "nested", "leaf.txt")
time.monotonic = lambda: 0 if os.path.lexists(leaf) else 1
`;
      const worker = await sshWorkerBundle("windows", "file");
      const result = await runOwnedSshCommand(
        backend.target,
        remotePython(clock + worker),
        ["windows-delete"],
        source,
        {
          input: Buffer.from(
            JSON.stringify({ operation: "delete-object", path: root, revision, budgetMs: 500 }) +
              "\n",
          ),
          effect: "unknown",
          timeoutMs: 10_000,
          maxBytes: 8192,
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        ok: true,
        data: { removed: ["nested/leaf.txt"], next: "nested" },
      });
      expect((await backend.list(root)).map((entry) => entry.name)).toEqual(["nested"]);
      expect(await backend.list(`${root}/nested`)).toEqual([]);

      // Also check the controller's deadline refusal with a budget that expires before mutation.
      const after = await backend.lstat(root);
      await backend.withDeleteWorker(root, {}, async (worker) => {
        await expect(worker.removeObject(root, "0".repeat(64))).rejects.toMatchObject({
          code: "DELETE_TARGET_CHANGED",
          effect: "not-applied",
          source,
        });
        await expect(
          worker.removeObject(root, after.revision, { timeoutMs: 1_500 }),
        ).rejects.toMatchObject({ code: "DELETE_TIMEOUT", effect: "not-applied", source });
      });
      expect((await backend.list(root)).map((entry) => entry.name)).toEqual(["nested"]);
    } finally {
      const cleanup = await backend.execute(
        remotePython(`import shutil\nshutil.rmtree(${JSON.stringify(native)})`),
        [],
        home,
      );
      expect(cleanup.exitCode, cleanup.stderr.toString()).toBe(0);
    }
  },
  30_000,
);
