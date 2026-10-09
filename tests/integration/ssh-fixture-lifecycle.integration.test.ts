import { spawn, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test, vi } from "vitest";

const run = promisify(execFile);

// A failed owner must not leave a private listener behind when finally never runs.
test.each(["exit", "crash"] as const)(
  "SSH fixture cleans up after owner %s",
  async (mode) => {
    const bundle = await build({
      stdin: {
        resolveDir: path.resolve("."),
        contents: `
import { startSshFixture } from './tests/integration/support/ssh-fixture.ts';
import { readFile } from 'node:fs/promises';
const fixture = await startSshFixture();
const daemonPid = Number(await readFile(fixture.root + '/sshd.pid', 'utf8'));
const stat = await readFile('/proc/' + daemonPid + '/stat', 'utf8');
console.log(JSON.stringify({ root: fixture.root, serverPid: fixture.serverPid, daemonPid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }));
${mode === "exit" ? "process.exit(0);" : "throw Error('Owned fixture owner crash');"}
`,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
    });
    const code = bundle.outputFiles[0]?.text;
    if (!code) throw Error("No fixture owner program");
    const owner = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    owner.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    owner.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      owner.once("exit", resolve);
      owner.once("error", reject);
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("root" in parsed) ||
      typeof parsed.root !== "string" ||
      !("serverPid" in parsed) ||
      typeof parsed.serverPid !== "number" ||
      !("daemonPid" in parsed) ||
      typeof parsed.daemonPid !== "number" ||
      !("startTicks" in parsed) ||
      typeof parsed.startTicks !== "string"
    )
      throw Error("No exact owned fixture receipt");
    const receipt = {
      root: parsed.root,
      serverPid: parsed.serverPid,
      daemonPid: parsed.daemonPid,
      startTicks: parsed.startTicks,
    };
    expect(receipt.root).toMatch(/^\/tmp\/\.tmp\/pi-ide-ssh-[a-zA-Z\d]+$/u);
    try {
      expect(exit, stderr).toBe(mode === "exit" ? 0 : 1);
      await vi.waitFor(
        async () => {
          await expect(access(`/proc/${receipt.daemonPid}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(access(`/proc/${receipt.serverPid}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(access(receipt.root)).rejects.toMatchObject({ code: "ENOENT" });
        },
        { timeout: 3000, interval: 50 },
      );
    } finally {
      // RED runs use an exact owned kernel handle, never a signal to a discovered numeric PID.
      await run("python3", [
        "-c",
        `
import os,pathlib,select,shutil,signal,sys
root=pathlib.Path(sys.argv[1]); pid=int(sys.argv[2]); process=pathlib.Path('/proc')/str(pid)
if process.exists():
 handle=os.pidfd_open(pid)
 try:
  raw=(process/'stat').read_text(); assert raw[raw.rfind(')')+2:].split()[19]==sys.argv[3]
  assert (process/'exe').resolve()==pathlib.Path('/usr/sbin/sshd')
  assert str(root/'sshd_config').encode() in (process/'cmdline').read_bytes()
  assert not (process/'task'/str(pid)/'children').read_text().strip()
  signal.pidfd_send_signal(handle,signal.SIGTERM); assert select.select([handle],[],[],5)[0]
 finally: os.close(handle)
if root.exists(): shutil.rmtree(root)
`,
        receipt.root,
        String(receipt.daemonPid),
        receipt.startTicks,
      ]);
    }
  },
  15000,
);
