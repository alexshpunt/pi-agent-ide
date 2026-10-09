import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import { startSshDapTransport } from "#src/backend/dap-transport.js";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";

for (const fault of ["foreign peer", "prompt queue overflow"] as const) {
  test(`R refuses ${fault} without waiting for a response timeout`, async () => {
    const fixture = await startSshFixture(
      {},
      {
        PI_R_PATH: "{workspace}/foreign-r.py",
        PI_IDE_R_MARKER: "{workspace}/received.txt",
        ...(fault === "prompt queue overflow" ? { PI_IDE_R_FLOW_SPAM: "1" } : {}),
      },
    );
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const backend = registry.resolve(scope)?.backend;
    const owner = createSshDebuggerWorkspaceOwner(registry)(scope);
    if (!backend || !owner) throw new Error("Missing owner");
    let client: Awaited<ReturnType<typeof owner.prepare>>["client"] | undefined;
    try {
      const script = `${fixture.workspace}/foreign-r.py`;
      await backend.write(
        script,
        await readFile("tests/integration/fixtures/dap-r-foreign-peer.py"),
        null,
      );
      const permission = await backend.execute(
        "python3",
        ["-c", "import os,sys; os.chmod(sys.argv[1],0o755)", script],
        fixture.workspace,
      );
      expect(permission.exitCode).toBe(0);
      const source = `${scope}/note.R`;
      const owned = await owner.prepare({
        adapter: "r",
        cwd: scope,
        program: source,
        sourceFile: source,
        args: [],
      });
      client = owned.client;
      const initialized = client.request("initialize", {}, { timeoutMs: 5000 });
      const result =
        fault === "foreign peer"
          ? initialized
          : initialized.then(() => owned.client.request("threads", {}, { timeoutMs: 5000 }));
      await expect(result).rejects.not.toThrow(/timed out/iu);
      await expect(backend.stat(`${fixture.workspace}/received.txt`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      try {
        await client?.dispose();
      } finally {
        await fixture.stop();
      }
    }
  }, 15000);
}

test("unexpected native R exit rejects authoritative transport completion", async () => {
  const fixture = await startSshFixture(
    {},
    {
      PI_R_PATH: "{workspace}/foreign-r.py",
      PI_IDE_R_EXIT_FAILURE: "1",
    },
  );
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const backend = registry.resolve(scope)?.backend;
  if (!backend) throw new Error("Missing owner");
  let client: DapClient | undefined;
  try {
    const script = `${fixture.workspace}/foreign-r.py`;
    await backend.write(
      script,
      await readFile("tests/integration/fixtures/dap-r-foreign-peer.py"),
      null,
    );
    const permission = await backend.execute(
      "python3",
      ["-c", "import os,sys; os.chmod(sys.argv[1],0o755)", script],
      fixture.workspace,
    );
    expect(permission.exitCode).toBe(0);
    const worker = await readFile("src/backend/dap-r-worker.py", "utf8");
    const transport = await startSshDapTransport(registry, scope, {
      command: "python3",
      args: ["-c", worker],
    });
    client = DapClient.fromTransport(transport);
    await client.request("initialize", {}, { timeoutMs: 5000 });
    await expect(client.request("threads", {}, { timeoutMs: 5000 })).rejects.not.toThrow(
      /timed out/iu,
    );
    await expect(transport.completion).rejects.toMatchObject({ code: "ADAPTER_EXITED" });
  } finally {
    try {
      await client?.dispose();
    } finally {
      await fixture.stop();
    }
  }
}, 15000);
const executable = process.env.PI_IDE_R_PATH;
test.skipIf(!executable)(
  "real target R handles browser prompts, steps and removes its owned process",
  async () => {
    if (!executable) throw new Error("Missing explicitly selected R runtime");
    const fixture = await startSshFixture({}, { PI_R_PATH: executable });
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const backend = registry.resolve(scope)?.backend;
    if (!backend) throw new Error("Missing owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      const native = `${fixture.workspace}/note-café.R`;
      await backend.write(
        native,
        Buffer.from(
          'run <- function() {\n  value <- 42\n  pid <- Sys.getpid()\n  value <- value + 1\n  cat("café", value, "\\n")\n}\nrun()\n',
        ),
        null,
      );
      const source = remoteLocation("fixture", native).source;
      const session = manager.create({ adapter: "r", cwd: scope, program: source, args: [] });
      const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 4);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(breakpoint.verified).toBe(true);
      expect(session.stop?.frame?.source?.path).toBe(source);
      expect((await manager.evaluate(session, "value")).result).toMatch(/\b42\b/u);
      const pidResult = (await manager.evaluate(session, "pid")).result;
      // Keep the adapter's R display intact; parse only the selected owned PID for cleanup checks.
      const match = /^(?:\[1\]\s*)?(\d+)$/u.exec(pidResult.trim());
      if (!match) throw new Error(`Unexpected owned R PID display: ${pidResult}`);
      const pid = Number(match[1]);
      const generation = session.stopGeneration;
      await manager.command(session, "next");
      expect(session.stopGeneration).toBeGreaterThan(generation);
      expect((await manager.evaluate(session, "value")).result).toMatch(/\b43\b/u);
      await manager.command(session, "continue");
      expect(session.status).toBe("terminated");
      await manager.delete(session.source);
      await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  60000,
);
