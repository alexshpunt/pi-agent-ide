import { expect, test } from "vitest";
import { startSshProcess } from "#src/backend/ssh-channel.ts";
import { startSshFixture } from "./support/ssh-fixture.ts";
import { probeOwnedSshTree } from "./support/ssh-tree-probe.ts";

// The command double-forks orphans that the channel adopts, lets them exit and, still running,
// watches for zombies. It exits with 5 so the test also sees the leader's own status.
const ORPHANS_EXIT_WHILE_RUNNING = `import json,os,time
channel=os.getppid();orphans=[]
for _ in range(20):
    read_fd,write_fd=os.pipe()
    child=os.fork()
    if child==0:
        os.close(read_fd)
        grandchild=os.fork()
        if grandchild==0:
            deadline=time.monotonic()+3
            while os.getppid()!=channel and time.monotonic()<deadline:time.sleep(0.01)
            os.write(write_fd,str(os.getppid()).encode());os._exit(0)
        os.write(write_fd,(str(grandchild)+' ').encode());os._exit(0)
    os.close(write_fd);received=b''
    while chunk:=os.read(read_fd,64):received+=chunk
    os.close(read_fd);os.waitpid(child,0)
    pid,parent=map(int,received.split());orphans.append((pid,parent))
def zombie(pid):
    try:
        raw=open('/proc/%d/stat'%pid).read();return raw[raw.rfind(')')+2]=='Z'
    except FileNotFoundError:return False
deadline=time.monotonic()+1
while any(zombie(pid) for pid,_ in orphans) and time.monotonic()<deadline:time.sleep(0.02)
print(json.dumps({'adopted':all(parent==channel for _,parent in orphans),'zombies':sum(zombie(pid) for pid,_ in orphans)}),flush=True)
raise SystemExit(5)
`;

for (const pty of [false, true]) {
  test(`owned ${pty ? "PTY" : "pipe"} command has adopted orphans reaped while it still runs`, async () => {
    const fixture = await startSshFixture();
    try {
      const channel = await startSshProcess(
        {
          id: "fixture",
          host: "fixture",
          workspace: fixture.workspace,
          configFile: fixture.config,
        },
        "python3",
        ["-c", ORPHANS_EXIT_WHILE_RUNNING],
        fixture.workspace,
        pty ? { pty: { cols: 200, rows: 24 } } : {},
      );
      const output: Buffer[] = [];
      channel.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      channel.stderr.resume();
      const completion = await channel.completion;
      const report: unknown = JSON.parse(Buffer.concat(output).toString("utf8").trim());
      expect(report).toEqual({ adopted: true, zombies: 0 });
      expect(completion).toMatchObject({ exitCode: 5 });
    } finally {
      await fixture.stop();
    }
  }, 20_000);
}

for (const pty of [false, true]) {
  test.each(["cancel", "exit", "loss"] as const)(
    `owned ${pty ? "PTY" : "pipe"} %s reaps descendants that opened new sessions without touching a sibling`,
    async (mode) => {
      const proof = await probeOwnedSshTree(mode, pty);
      expect(proof).toMatchObject({
        mode,
        pty,
        nativeGoneBeforeTeardown: true,
        siblingRetained: true,
        sourcePreserved: true,
      });
      expect(new Set([proof.leader, proof.child, proof.grandchild]).size).toBe(3);
      if (mode !== "exit") {
        expect(proof.childIdentity).toMatch(/:[0-9]+$/u);
        expect(proof.grandchildIdentity).toMatch(/:[0-9]+$/u);
      }
    },
    20_000,
  );
}
