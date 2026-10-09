import { readFile } from "node:fs/promises";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshConfiguredProcessAccess } from "#src/backend/configured-process.js";
import { runConfiguredProcess } from "#src/api/tool-config.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { SshBackendError } from "#src/backend/ssh.js";
import type { SshProcessChannel } from "#src/backend/ssh-channel.js";

/** Check actual native cancellation cleanup before fixture teardown, without undoing a command's write. */
export async function probeOwnedCommandCancellation(
  mode: "cancel" | "deadline",
  kind: "configured" | "execute",
) {
  const fixture = await startSshFixture();
  const project = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const owner = registry.resolve(project);
  if (!owner) throw new Error("Missing fixture owner");
  const backend = owner.backend;
  const source = `${fixture.workspace}/note.py`;
  const marker = `${fixture.workspace}/command.pid`;
  const release = `${fixture.workspace}/release`;
  const controller = new AbortController();
  let sibling: SshProcessChannel | undefined;
  let pending: Promise<unknown> | undefined;
  let pid: number | undefined;
  const result = await (async () => {
    sibling = await backend.startProcess(
      "python3",
      ["-c", "import time; time.sleep(30)"],
      fixture.workspace,
    );
    sibling.stdout.resume();
    sibling.stderr.resume();
    const script = await readFile("tests/integration/fixtures/configured-owner-wait.py", "utf8");
    pending = (
      kind === "execute"
        ? backend.execute("python3", ["-c", script, source, marker, release], fixture.workspace, {
            signal: controller.signal,
            timeoutMs: 4000,
          })
        : runConfiguredProcess(
            { command: ["python3", "-c", script, "{file}", marker, release], timeoutMs: 4000 },
            {
              projectRoot: project,
              filePath: `${project}/note.py`,
              processAccess: createSshConfiguredProcessAccess(registry),
              signal: controller.signal,
            },
          )
    ).catch((error: unknown) => error);
    const observed = await backend.execute(
      "python3",
      [
        "-c",
        "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3\nwhile not p.exists() and time.monotonic()<end: time.sleep(.02)\nprint(p.read_text() if p.exists() else 'missing')",
        marker,
      ],
      fixture.workspace,
    );
    pid = Number(observed.stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("No exact native command PID");
    if (mode === "cancel") controller.abort(new Error("Cancel my configured command"));
    const outcome = await pending;
    if (
      !(outcome instanceof SshBackendError) ||
      outcome.code !== (mode === "cancel" ? "CANCELLED" : "TIMEOUT") ||
      outcome.effect !== "unknown"
    )
      throw new Error("Target command did not retain its failure and unknown write effect", {
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
    const changedSource = (await backend.read(source)).bytes.toString("utf8");
    const sourcePreserved = changedSource === 'label = "café after command"\n';
    if (!nativeGoneBeforeTeardown || !siblingAliveBeforeTeardown || !sourcePreserved)
      throw new Error("Target command cleanup failed its native ownership contract");
    return {
      root: fixture.root,
      project,
      mode,
      kind,
      pid,
      siblingPid: sibling.pid,
      nativeGoneBeforeTeardown,
      siblingAliveBeforeTeardown,
      sourcePreserved,
      changedSource,
      code: outcome.code,
      effect: outcome.effect,
    };
  })().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  try {
    await backend.write(release, Buffer.from("release\n"), null);
    await pending;
    if (pid !== undefined) {
      const released = await backend.execute(
        "python3",
        [
          "-c",
          "import pathlib,sys,time; p=pathlib.Path('/proc')/sys.argv[1]; end=time.monotonic()+3\nwhile p.exists() and time.monotonic()<end: time.sleep(.02)\nprint('alive' if p.exists() else 'gone')",
          String(pid),
        ],
        fixture.workspace,
      );
      if (released.stdout.toString("utf8") !== "gone\n")
        throw new Error("Owned command did not exit after its release file");
    }
    await sibling?.stop();
    await fixture.stop();
  } catch (cleanupError) {
    if (!result.ok)
      throw new AggregateError(
        [result.error, cleanupError],
        "Owned command probe and cleanup failed",
        { cause: cleanupError },
      );
    throw cleanupError;
  }
  if (!result.ok) throw result.error;
  return result.value;
}
