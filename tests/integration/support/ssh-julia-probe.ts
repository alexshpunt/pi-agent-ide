import { access } from "node:fs/promises";
import { JULIA_DEBUG_SOURCE } from "#integration/fixtures/julia-debug-source.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { findSshProcessMetadata, readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Explicit private Julia installation; the depot must belong to the fixture account. */
export interface PrivateJuliaInstallation {
  readonly runtime: string;
  readonly project: string;
  readonly depot: string;
}

/** Run the actual installed adapter and prove native cleanup before fixture teardown. */
export async function probeOwnedSshJulia(installation: PrivateJuliaInstallation) {
  const fixture = await startSshFixture(
    {},
    {
      PI_JULIA_PATH: installation.runtime,
      PI_JULIA_DEBUG_PROJECT: installation.project,
      JULIA_DEPOT_PATH: installation.depot,
      JULIA_LOAD_PATH: "@:@stdlib",
      JULIA_NUM_THREADS: "1",
    },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const owner = registry.resolve(scope);
  if (!owner) throw new Error("No private Julia workspace owner");
  const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
  try {
    const version = await owner.backend.execute(
      installation.runtime,
      [
        "--startup-file=no",
        "--history-file=no",
        `--project=${installation.project}`,
        "-e",
        'using DebugAdapter; print(VERSION, "/", pkgversion(DebugAdapter))',
      ],
      fixture.workspace,
    );
    if (version.exitCode !== 0 || version.stdout.toString("utf8") !== "1.13.0/3.2.1")
      throw new Error(
        "The explicitly selected Julia installation differs from its pinned versions",
      );
    const native = `${fixture.workspace}/note-café.jl`;
    await owner.backend.write(native, Buffer.from(JULIA_DEBUG_SOURCE), null);
    const source = remoteLocation("fixture", native).source;
    const session = manager.create({ adapter: "julia", cwd: scope, program: source, args: [] });
    const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 4);
    await manager.start(session);
    if (
      session.status !== "stopped" ||
      !breakpoint.verified ||
      session.stop?.frame?.source?.path !== source ||
      session.stop.frame.line !== 4
    )
      throw new Error("Real Julia did not stop at the verified canonical source breakpoint");
    const before = (await manager.evaluate(session, "value")).result;
    if (before !== "42") throw new Error(`Unexpected Julia value before stepping: ${before}`);
    const pidText = (await manager.evaluate(session, "pid")).result;
    if (!/^\d+$/u.test(pidText)) throw new Error("Julia did not return an exact native PID");
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1 || !session.remote)
      throw new Error("No exact native Julia lifetime metadata");
    const relayPid = session.remote.pid;
    const julia = (await readSshProcessMetadata(registry, scope, pid))[0];
    const relay = (await readSshProcessMetadata(registry, scope, relayPid))[0];
    if (!julia || !relay || julia.parentPid !== relayPid || pid === relayPid)
      throw new Error("The stopped Julia process is not the owned relay's actual native child");
    const generation = session.stopGeneration;
    await manager.command(session, "next");
    const after = (await manager.evaluate(session, "value")).result;
    const stepped = manager.snapshot(session);
    if (
      stepped.status !== "stopped" ||
      session.stopGeneration <= generation ||
      after !== "43" ||
      stepped.stop?.frame?.source?.path !== source ||
      stepped.stop.frame.line !== 5
    )
      throw new Error("Real Julia did not step to the next canonical source line and value 43");
    await manager.command(session, "continue");
    if (manager.snapshot(session).status !== "terminated")
      throw new Error("Real Julia did not finish on continue");
    await manager.delete(session.source);
    const nativeGoneBeforeTeardown =
      (await findSshProcessMetadata(registry, scope, pid)) === undefined &&
      (await findSshProcessMetadata(registry, scope, relayPid)) === undefined;
    if (!nativeGoneBeforeTeardown)
      throw new Error("Julia or its owned relay survived session cleanup");
    const sourcePreserved = (await owner.backend.read(native)).bytes.equals(
      Buffer.from(JULIA_DEBUG_SOURCE),
    );
    if (!sourcePreserved) throw new Error("The native debugger changed the Julia source");
    return {
      root: fixture.root,
      source,
      pid,
      relayPid,
      identity: julia.identity,
      relayIdentity: relay.identity,
      before,
      after,
      nativeGoneBeforeTeardown,
      sourcePreserved,
    };
  } finally {
    try {
      await manager.dispose();
    } finally {
      await fixture.stop();
      await access(fixture.root).then(
        () => {
          throw new Error("Julia fixture root survived awaited teardown");
        },
        (error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        },
      );
    }
  }
}
