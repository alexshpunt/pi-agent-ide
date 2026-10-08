import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import {
  probeAbandonedLspCleanup,
  probeOwnedLspCleanup,
} from "#integration/support/lsp-cleanup-probe.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { createSshLspTransport } from "#src/backend/lsp-transport.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";

test("a reported SSH stop failure cannot skip another server's physical cleanup", async () => {
  const proof = await probeOwnedLspCleanup();
  expect(proof.pids).toHaveLength(2);
  expect(proof).toMatchObject({
    waitedForSibling: true,
    firstGoneBeforeRelease: true,
    siblingAliveBeforeRelease: true,
    allGoneAfterCleanup: true,
    preservedFailure: true,
  });
}, 30_000);

test.each(["cancel", "dispose"] as const)(
  "pending SSH startup reports failed cleanup before fixture teardown (%s)",
  async (mode) => {
    const proof = await probeAbandonedLspCleanup(mode);
    expect(proof.pid).toBeGreaterThan(0);
    expect(proof).toMatchObject({
      goneBeforeTeardown: true,
      preservedCancellation: true,
      preservedFailure: true,
      operationReportedFailure: true,
    });
  },
  30_000,
);

// Observe the actual process before initialize responds, not a mocked client startup.
test.each([false, true])(
  "cancelling startup reaps only its abandoned SSH server (shared=%s)",
  async (shared) => {
    const fixture = await startSshFixture();
    const root = `ssh://fixture${fixture.workspace}`;
    const backends = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const access = createSshLspWorkspaceOwner(backends);
    const owner = backends.resolve(root);
    if (!owner) throw new Error("Missing fixture owner");
    let serverPid: number | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = createSshLspTransport(backends, root);
    access.transport = () => ({
      ...transport,
      async start(input) {
        const process = await transport.start(input);
        serverPid = process.remote.pid;
        entered?.();
        return process;
      },
    });
    let manager: LspManager | undefined;
    try {
      await owner.backend.write(
        `${fixture.workspace}/server.py`,
        await readFile(path.resolve("tests/integration/fixtures/lsp-owner-server.py")),
        null,
      );
      const servers = LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            owned: {
              command: ["python3", "{project}/server.py"],
              rootMarkers: [],
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: ["diagnostics"],
              initializationOptions: { ownerInitializeDelay: 1 },
            },
          },
        },
        root,
      );
      manager = LspManager.init(servers, access);
      const controller = new AbortController();
      const abandoned = manager.getOrStart(".ts", root, "symbols", controller.signal);
      const outcome = abandoned.then(
        () => "ready",
        (error: unknown) => error,
      );
      const retained = shared ? manager.getOrStart(".ts", root, "symbols") : undefined;
      await started;
      expect(serverPid).toBeTypeOf("number");
      const failure = new Error("Cancel my startup wait");
      controller.abort(failure);
      expect(await outcome).toBe(failure);
      if (shared) {
        const client = await retained;
        expect(client?.ready).toBe(true);
        expect(client?.remote?.pid).toBe(serverPid);
        expect(await client?.sendRequest("matrix/status", {})).toMatchObject({ serverPid });
      } else {
        expect(manager.clientCount).toBe(0);
        await expect(readSshProcessMetadata(backends, root, serverPid)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await manager.shutdownAll();
      await expect(readSshProcessMetadata(backends, root, serverPid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager?.shutdownAll();
      await LspManager.resetForTest();
      await fixture.stop();
    }
  },
  30_000,
);
