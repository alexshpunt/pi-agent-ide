import { startSshProcess } from "#src/backend/ssh-channel.js";
import { SshBackendError } from "#src/backend/ssh.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { startSshCarrierFixture } from "./ssh-carrier-fixture.js";

/** Check exact adopted descendants and an independent sibling before disposing the private SSH fixture. */
export async function probeOwnedSshTree(mode: "cancel" | "exit" | "loss", pty: boolean) {
  const fixture = await startSshCarrierFixture();
  const backend = fixture.direct;
  const project = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([backend.target]);
  const marker = `${fixture.workspace}/tree-ready`;
  const release = `${fixture.workspace}/release-tree`;
  const source = `${fixture.workspace}/source.txt`;
  const original = Buffer.from("Owned café tree source\n");
  const controller = new AbortController();
  const failures: unknown[] = [];
  let result:
    | {
        root: string;
        mode: string;
        pty: boolean;
        leader: number;
        child: number;
        grandchild: number;
        childIdentity: string | undefined;
        grandchildIdentity: string | undefined;
        nativeGoneBeforeTeardown: boolean;
        siblingRetained: boolean;
        sourcePreserved: boolean;
      }
    | undefined;
  let channel: Awaited<ReturnType<typeof startSshProcess>> | undefined;
  let sibling: Awaited<ReturnType<typeof startSshProcess>> | undefined;
  let children: number[] = [];
  try {
    await backend.write(source, original, null);
    sibling = await startSshProcess(
      backend.target,
      "python3",
      ["-c", "import time; time.sleep(60)"],
      fixture.workspace,
    );
    sibling.stdout.resume();
    sibling.stderr.resume();
    const siblingBefore = (await readSshProcessMetadata(registry, project, sibling.pid))[0];
    if (!siblingBefore?.identity) throw new Error("No independent sibling identity");
    const code = `import json,os,pathlib,signal,sys,time
marker,release=map(pathlib.Path,sys.argv[1:3]);mode=sys.argv[3]
for sig in (signal.SIGTERM,signal.SIGHUP):signal.signal(sig,signal.SIG_IGN)
read_fd,write_fd=os.pipe()
child=os.fork()
if child==0:
    os.close(read_fd)
    os.setsid()
    grandchild=os.fork()
    if grandchild==0:
        os.setsid()
        os.write(write_fd,str(os.getpid()).encode());os.close(write_fd)
        deadline=time.monotonic()+30
        while not release.exists() and time.monotonic()<deadline:time.sleep(0.02)
        os._exit(0)
    os.close(write_fd)
    while not release.exists():time.sleep(0.02)
    os.waitpid(grandchild,0);os._exit(0)
os.close(write_fd)
grandchild=int(os.read(read_fd,32));os.close(read_fd)
marker.write_text(json.dumps({'child':child,'grandchild':grandchild,'parent':os.getpid()}))
if mode=='exit':sys.exit(7)
while not release.exists():time.sleep(0.02)
os.waitpid(child,0)
`;
    channel = await startSshProcess(
      fixture.target,
      "python3",
      ["-c", code, marker, release, mode],
      fixture.workspace,
      { signal: controller.signal, ...(pty ? { pty: { cols: 80, rows: 24 } } : {}) },
    );
    channel.stdout.resume();
    channel.stderr.resume();
    const completed = channel.completion.catch((error: unknown) => error);
    const ready = await backend.execute(
      "python3",
      [
        "-c",
        `import pathlib,sys,time
p=pathlib.Path(sys.argv[1]);deadline=time.monotonic()+3
while not p.exists() and time.monotonic()<deadline:time.sleep(0.02)
print(p.read_text())`,
        marker,
      ],
      fixture.workspace,
    );
    const receipt: unknown = JSON.parse(ready.stdout.toString("utf8"));
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("child" in receipt) ||
      typeof receipt.child !== "number" ||
      !("grandchild" in receipt) ||
      typeof receipt.grandchild !== "number" ||
      !("parent" in receipt) ||
      receipt.parent !== channel.pid ||
      !Number.isSafeInteger(receipt.child) ||
      receipt.child < 1 ||
      !Number.isSafeInteger(receipt.grandchild) ||
      receipt.grandchild < 1
    )
      throw new Error("Invalid owned tree receipt");
    children = [receipt.child, receipt.grandchild];
    let identities: Array<string | undefined> = [];
    if (mode !== "exit") {
      const [child, grandchild] = await Promise.all([
        readSshProcessMetadata(registry, project, receipt.child),
        readSshProcessMetadata(registry, project, receipt.grandchild),
      ]);
      if (
        child[0]?.parentPid !== channel.pid ||
        grandchild[0]?.parentPid !== receipt.child ||
        !child[0].identity ||
        !grandchild[0].identity
      )
        throw new Error("Descendant ancestry was not independently confirmed");
      identities = [child[0].identity, grandchild[0].identity];
    }
    if (mode === "cancel") controller.abort(new Error("Cancel this exact owned tree"));
    if (mode === "loss" && (await fixture.dropConnections()) !== 1)
      throw new Error("Wrong owned TCP connection count");
    const outcome = await completed;
    if (mode === "exit") {
      if (
        typeof outcome !== "object" ||
        outcome === null ||
        !("exitCode" in outcome) ||
        outcome.exitCode !== 7
      )
        throw new Error("Native leader exit was not preserved");
    } else if (
      !(outcome instanceof SshBackendError) ||
      outcome.code !== (mode === "cancel" ? "CANCELLED" : "TRANSPORT_FAILED") ||
      outcome.effect !== "unknown"
    ) {
      throw new Error("Interruption outcome was not truthful", { cause: outcome });
    }
    if (mode === "loss") {
      const waited = await backend.execute(
        "python3",
        [
          "-c",
          `import pathlib,sys,time
paths=[pathlib.Path('/proc/'+pid) for pid in sys.argv[1:]];deadline=time.monotonic()+3
while any(p.exists() for p in paths) and time.monotonic()<deadline:time.sleep(0.02)
if any(p.exists() for p in paths):raise RuntimeError('Owned tree survived carrier loss')`,
          String(channel.pid),
          ...children.map(String),
        ],
        fixture.workspace,
      );
      if (waited.exitCode !== 0) throw new Error("Owned tree survived carrier loss");
    }
    for (const pid of [channel.pid, ...children]) {
      try {
        await readSshProcessMetadata(registry, project, pid);
      } catch (error) {
        if (error instanceof SshBackendError && error.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Owned native PID ${pid} survived completion`);
    }
    const siblingAfter = (await readSshProcessMetadata(registry, project, sibling.pid))[0];
    if (siblingAfter?.identity !== siblingBefore.identity)
      throw new Error("Independent sibling changed");
    if (!(await backend.read(source)).bytes.equals(original))
      throw new Error("Independent source changed");
    result = {
      root: fixture.root,
      mode,
      pty,
      leader: channel.pid,
      child: receipt.child,
      grandchild: receipt.grandchild,
      childIdentity: identities[0],
      grandchildIdentity: identities[1],
      nativeGoneBeforeTeardown: true,
      siblingRetained: true,
      sourcePreserved: true,
    };
  } catch (error) {
    failures.push(error);
  }
  try {
    await backend.write(release, Buffer.from("release only this fixture's children"), null);
    if (children.length) {
      const exited = await backend.execute(
        "python3",
        [
          "-c",
          `import pathlib,sys,time
paths=[pathlib.Path('/proc/'+pid+'/stat') for pid in sys.argv[1:]];deadline=time.monotonic()+4
def living(p):
    try:
        raw=p.read_text();return raw[raw.rfind(')')+2:].split()[0]!='Z'
    except FileNotFoundError:return False
while any(living(p) for p in paths) and time.monotonic()<deadline:time.sleep(0.02)
if any(living(p) for p in paths):raise RuntimeError('Own release did not stop descendants')`,
          ...children.map(String),
        ],
        fixture.workspace,
      );
      if (exited.exitCode !== 0) throw new Error("Fixture descendants still running");
    }
    if (channel)
      await channel.stop().catch((error: unknown) => {
        if (
          !(error instanceof SshBackendError) ||
          !["CANCELLED", "TRANSPORT_FAILED"].includes(error.code)
        )
          throw error;
      });
    if (sibling) await sibling.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "Owned tree probe or cleanup failed");
  if (!result) throw new Error("No owned tree result");
  return result;
}
