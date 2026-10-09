import path from "node:path";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { SshBackendError } from "#src/backend/ssh.js";
import type { SshProcessChannel } from "#src/backend/ssh-channel.js";

/** Verify guarded index interruption against its exact native Git child before fixture teardown. */
export async function probeOwnedGitCancellation(mode: "cancel" | "deadline") {
  const fixture = await startSshFixture({
    git: path.resolve("tests/integration/fixtures/git-index-owned-wait.py"),
  });
  const project = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(project);
  if (!owner) throw new Error("Missing fixture owner");
  const backend = owner.backend;
  const controller = new AbortController();
  let sibling: SshProcessChannel | undefined;
  let pending: Promise<unknown> | undefined;
  let pid: number | undefined;
  const operation = await (async () => {
    const git = async (...args: string[]) => {
      const result = await backend.execute("/usr/bin/git", args, fixture.workspace);
      if (result.exitCode !== 0) throw new Error("Owned fixture Git setup failed");
      return result.stdout.toString("utf8").trim();
    };
    await git("init", "--quiet");
    const source = "Owned café index\n";
    await backend.write(`${fixture.workspace}/note.txt`, Buffer.from(source), null);
    await git("add", "--", "note.txt");
    await git(
      "-c",
      "user.name=Owned fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Owned initial index",
    );
    const head = await git("rev-parse", "HEAD");
    const index = (await backend.read(`${fixture.workspace}/.git/index`)).bytes;
    sibling = await backend.startProcess(
      "python3",
      ["-c", "import time; time.sleep(30)"],
      fixture.workspace,
    );
    sibling.stdout.resume();
    sibling.stderr.resume();
    pending = backend
      .writeGitIndex(
        fixture.workspace,
        {
          repositoryPath: "note.txt",
          mode: "100644",
          text: "Changed café index\n",
          expectedHead: head,
          expectedIndexText: source,
          expectedIndexMode: "100644",
          expectedWorktreeText: source,
        },
        { signal: controller.signal, timeoutMs: 5000 },
      )
      .catch((error: unknown) => error);
    const ready = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import pathlib,time; p=pathlib.Path('git-owned-ready'); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
      ],
      fixture.workspace,
    );
    pid = Number(ready.stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("No exact native Git child PID");
    const before = (await readSshProcessMetadata(registry, project, pid))[0];
    if (!before?.identity || !before.command.includes("rev-parse --git-path index"))
      throw new Error("Native Git child identity was not established");
    if (mode === "cancel") controller.abort(new Error("Cancel my guarded Git index publication"));
    const outcome = await pending;
    if (
      !(outcome instanceof SshBackendError) ||
      outcome.code !== (mode === "cancel" ? "CANCELLED" : "TIMEOUT") ||
      outcome.effect !== "unknown"
    )
      throw new Error("Git interruption did not retain its failure and unknown effect", {
        cause: outcome,
      });
    let nativeGoneBeforeTeardown = false;
    try {
      await readSshProcessMetadata(registry, project, pid);
    } catch (error) {
      if (!(error instanceof SshBackendError) || error.code !== "ENOENT") throw error;
      nativeGoneBeforeTeardown = true;
    }
    const siblingAliveBeforeTeardown =
      (await readSshProcessMetadata(registry, project, sibling.pid))[0]?.identity ===
      sibling.identity;
    const indexPreserved = (await backend.read(`${fixture.workspace}/.git/index`)).bytes.equals(
      index,
    );
    const sourcePreserved =
      (await backend.read(`${fixture.workspace}/note.txt`)).bytes.toString("utf8") === source;
    if (
      !nativeGoneBeforeTeardown ||
      !siblingAliveBeforeTeardown ||
      !indexPreserved ||
      !sourcePreserved
    )
      throw new Error(`Git interruption failed its native cleanup contract for ${pid}`);
    return {
      root: fixture.root,
      project,
      mode,
      pid,
      identity: before.identity,
      siblingPid: sibling.pid,
      nativeGoneBeforeTeardown,
      siblingAliveBeforeTeardown,
      indexPreserved,
      sourcePreserved,
      code: outcome.code,
      effect: outcome.effect,
    };
  })().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  const failures: unknown[] = operation.ok ? [] : [operation.error];
  try {
    await backend.write(`${fixture.workspace}/git-owned-release`, Buffer.from("release\n"), null);
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
        throw new Error("Owned Git child did not exit before fixture teardown");
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await sibling?.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Guarded Git cancellation probe failed");
  if (!operation.ok) throw new Error("Git cancellation probe failed", { cause: operation.error });
  return operation.value;
}
