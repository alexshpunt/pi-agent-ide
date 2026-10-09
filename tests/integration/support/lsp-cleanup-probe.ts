import { readFile } from "node:fs/promises";
import path from "node:path";
import { startSshFixture } from "./ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";

/** Check pending native startup cleanup with a synthetic failed stop acknowledgement. */
export async function probeAbandonedLspCleanup(mode: "cancel" | "dispose"): Promise<{
  root: string;
  pid: number;
  goneBeforeTeardown: boolean;
  preservedCancellation: boolean;
  preservedFailure: boolean;
  operationReportedFailure: boolean;
}> {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const backends = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const access = createSshLspWorkspaceOwner(backends);
  const owner = backends.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const transport = createSshLspTransport(backends, root);
  const failure = new Error("Synthetic pending stop acknowledgement failure");
  const cancellation = new Error("Cancel pending native startup");
  let entered: (() => void) | undefined;
  let pid: number | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  access.transport = () => ({
    ...transport,
    async start(input) {
      const process = await transport.start(input);
      pid = process.remote.pid;
      entered?.();
      return {
        ...process,
        async stop() {
          await process.stop();
          throw failure;
        },
      };
    },
  });
  let manager: LspManager | undefined;
  let observed: Promise<unknown> | undefined;
  try {
    await owner.backend.write(
      `${fixture.workspace}/server.py`,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            pending: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              capabilities: [],
              languages: { typescript: { extensions: [".ts"] } },
              initializationOptions: { ownerInitializeDelay: 15 },
            },
          },
        },
        root,
      ),
      access,
    );
    const controller = new AbortController();
    observed = manager
      .getOrStart(".ts", root, "symbols", controller.signal)
      .catch((error: unknown) => error);
    await started;
    if (pid === undefined) throw new Error("Missing owned process identity");
    let disposalReport: unknown;
    if (mode === "cancel") controller.abort(cancellation);
    else disposalReport = await manager.dispose().catch((error: unknown) => error);
    const report = await observed;
    let goneBeforeTeardown = false;
    try {
      await readSshProcessMetadata(backends, root, pid);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      goneBeforeTeardown = true;
    }
    const leaves = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
    const errors = leaves(report);
    return {
      root,
      pid,
      goneBeforeTeardown,
      preservedCancellation:
        mode === "cancel"
          ? errors.includes(cancellation)
          : errors.some(
              (error) =>
                error instanceof Error && error.message === "Language server manager stopped",
            ),
      preservedFailure: errors.includes(failure),
      operationReportedFailure: leaves(mode === "cancel" ? report : disposalReport).includes(
        failure,
      ),
    };
  } finally {
    try {
      await manager?.shutdownAll();
      await observed;
      await LspManager.resetForTest();
    } finally {
      await fixture.stop();
    }
  }
}

/** Run a private native SSH cleanup check with a synthetic failed stop acknowledgement.
 * Reports process observations before fixture shutdown, never from fixture teardown.
 */
export async function probeOwnedLspCleanup(): Promise<{
  root: string;
  pids: number[];
  waitedForSibling: boolean;
  firstGoneBeforeRelease: boolean;
  siblingAliveBeforeRelease: boolean;
  allGoneAfterCleanup: boolean;
  preservedFailure: boolean;
}> {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const backends = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const access = createSshLspWorkspaceOwner(backends);
  const owner = backends.resolve(root);
  if (!owner) throw new Error("Missing fixture owner");
  const transport = createSshLspTransport(backends, root);
  const pids: number[] = [];
  let release: (() => void) | undefined;
  let firstStopped: (() => void) | undefined;
  let secondStopping: (() => void) | undefined;
  const firstGone = new Promise<void>((resolve) => {
    firstStopped = resolve;
  });
  const secondWaiting = new Promise<void>((resolve) => {
    secondStopping = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failure = new Error("Synthetic owned stop acknowledgement failure");
  access.transport = () => ({
    ...transport,
    async start(input) {
      const process = await transport.start(input);
      const index = pids.length;
      pids.push(process.remote.pid);
      return {
        ...process,
        async stop() {
          if (index === 1) {
            secondStopping?.();
            await gate;
          }
          await process.stop();
          if (index === 0) {
            firstStopped?.();
            throw failure;
          }
        },
      };
    },
  });
  const absent = async (pid: number) => {
    try {
      await readSshProcessMetadata(backends, root, pid);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  };
  let manager: LspManager | undefined;
  let observed: Promise<void> | undefined;
  try {
    await owner.backend.write(
      `${fixture.workspace}/server.py`,
      await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
      null,
    );
    const config = {
      command: ["python3", "{project}/server.py"],
      rootMarkers: [],
      capabilities: [],
      initializationOptions: { ownerIgnoreExit: true },
    };
    manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            first: { ...config, languages: { typescript: { extensions: [".ts"] } } },
            second: { ...config, languages: { python: { extensions: [".py"] } } },
          },
        },
        root,
      ),
      access,
    );
    await manager.getOrStart(".ts", root, "symbols");
    await manager.getOrStart(".py", root, "symbols");
    const [first, second] = pids;
    if (first === undefined || second === undefined)
      throw new Error("Missing owned process identity");
    let finished = false;
    const shutdown = manager.dispose();
    observed = shutdown.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await Promise.all([firstGone, secondWaiting]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitedForSibling = !finished;
    const firstGoneBeforeRelease = await absent(first);
    const siblingAliveBeforeRelease = !(await absent(second));
    release?.();
    const reported = await shutdown.then(
      () => undefined,
      (error: unknown) => error,
    );
    const preservedFailure =
      reported instanceof AggregateError &&
      reported.errors.some(
        (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
      );
    const allGoneAfterCleanup = (await Promise.all(pids.map(absent))).every(Boolean);
    return {
      root,
      pids,
      waitedForSibling,
      firstGoneBeforeRelease,
      siblingAliveBeforeRelease,
      allGoneAfterCleanup,
      preservedFailure,
    };
  } finally {
    release?.();
    await observed;
    await manager?.shutdownAll();
    await LspManager.resetForTest();
    await fixture.stop();
  }
}
