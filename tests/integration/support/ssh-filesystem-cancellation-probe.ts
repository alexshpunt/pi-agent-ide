import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import type { SshProcessChannel } from "#src/backend/ssh-channel.js";

/** Check native cleanup before unlocking a real filesystem operation or tearing down its fixture. */
export async function probeOwnedFilesystemCancellation(
  mode: "cancel" | "deadline",
  operation: "write" | "journal",
) {
  const fixture = await startSshFixture({
    python3: path.resolve("tests/integration/fixtures/filesystem-lock-observer.py"),
  });
  const project = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(project);
  if (!owner) throw new Error("Missing fixture owner");
  const backend = owner.backend;
  const controller = new AbortController();
  let holder: SshProcessChannel | undefined;
  let pending: Promise<unknown> | undefined;
  let pid: number | undefined;
  let journal: string | undefined;
  const result = await (async () => {
    const file = `${fixture.workspace}/filesystem-owned.txt`;
    const source = "Owned café before write\n";
    const revision = await backend.write(file, Buffer.from(source), null);
    holder = await backend.startProcess(
      "/usr/bin/python3",
      [
        "-c",
        "import fcntl,os,pathlib,time; fd=os.open('.',os.O_RDONLY|os.O_DIRECTORY); fcntl.flock(fd,fcntl.LOCK_EX); pathlib.Path('lock-holder-ready').write_text('ready'); time.sleep(30)",
      ],
      fixture.workspace,
    );
    holder.stdout.resume();
    holder.stderr.resume();
    const ready = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import pathlib,time; p=pathlib.Path('lock-holder-ready'); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('ready' if p.exists() else 'missing')",
      ],
      fixture.workspace,
    );
    if (ready.stdout.toString("utf8") !== "ready\n") throw new Error("Owned lock was not acquired");
    const context = { signal: controller.signal, timeoutMs: 5000 };
    pending = (
      operation === "write"
        ? backend.write(file, Buffer.from("Changed café after write\n"), revision, context)
        : backend.captureJournal(file, context)
    ).catch((error: unknown) => error);
    const observed = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import pathlib,time; p=pathlib.Path('filesystem-owned-ready'); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
      ],
      fixture.workspace,
    );
    pid = Number(observed.stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error("No exact native filesystem worker PID");
    const before = (await readSshProcessMetadata(registry, project, pid))[0];
    if (!before?.identity || !/^[a-f0-9-]+:[0-9]+$/u.test(before.identity))
      throw new Error("No exact native filesystem worker identity");
    if (operation === "journal") {
      const receipt = await backend.read(`${fixture.workspace}/filesystem-owned-journal`);
      journal = receipt.bytes.toString("utf8");
      if (!/^\/tmp\/\.pi-ide-journal-[a-zA-Z0-9_-]+$/u.test(journal))
        throw new Error("No exact owned journal directory");
    }
    if (mode === "cancel") controller.abort(new Error("Cancel my owned filesystem operation"));
    const error: unknown = await pending;
    const code = mode === "cancel" ? "CANCELLED" : "TIMEOUT";
    const effect = operation === "write" ? "unknown" : "not-applied";
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== code ||
      !("effect" in error) ||
      error.effect !== effect ||
      !("source" in error) ||
      error.source !== `${project}/filesystem-owned.txt`
    )
      throw new Error("Filesystem interruption lost its code, source or effect", { cause: error });
    const check = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import pathlib,sys; print('alive' if (pathlib.Path('/proc')/sys.argv[1]).exists() else 'gone')",
        String(pid),
      ],
      fixture.workspace,
    );
    if (check.stdout.toString("utf8") !== "gone\n")
      throw new Error("Filesystem interruption returned while its exact native worker was alive");
    if (
      (await readSshProcessMetadata(registry, project, holder.pid))[0]?.identity !== holder.identity
    )
      throw new Error("Filesystem interruption changed its owned lock holder");
    if ((await backend.read(file)).bytes.toString("utf8") !== source)
      throw new Error("Filesystem interruption changed the guarded source");
    if (journal !== undefined) {
      const absent = await backend.stat(journal).then(
        () => false,
        (failure: unknown) =>
          failure instanceof Error && "code" in failure && failure.code === "ENOENT",
      );
      if (!absent) throw new Error("Cancelled journal left its private allocation behind");
    }
    await holder.stop();
    if ((await backend.read(file)).bytes.toString("utf8") !== source)
      throw new Error("Cancelled filesystem worker wrote after the owned lock was released");
    return {
      root: fixture.root,
      project,
      mode,
      operation,
      pid,
      identity: before.identity,
      siblingPid: holder.pid,
      nativeGoneBeforeTeardown: true,
      siblingAliveBeforeTeardown: true,
      sourcePreserved: true,
      journalGoneBeforeTeardown: operation === "journal" ? true : undefined,
      code,
      effect,
    };
  })().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  const failures: unknown[] = result.ok ? [] : [result.error];
  try {
    await holder?.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await pending;
    if (pid !== undefined) {
      const gone = await backend.execute(
        "/usr/bin/python3",
        [
          "-c",
          "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
          String(pid),
        ],
        fixture.workspace,
      );
      if (gone.stdout.toString("utf8") !== "gone\n")
        throw new Error("Owned filesystem worker survived cleanup");
    }
    if (journal !== undefined) await backend.releaseJournal(journal);
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Filesystem cancellation probe failed");
  if (!result.ok) throw new Error("Filesystem cancellation proof is unavailable");
  return result.value;
}
