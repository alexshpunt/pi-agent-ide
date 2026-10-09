import { readFile } from "node:fs/promises";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import { startSshDapTransport } from "#src/backend/dap-transport.js";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const adapter = process.env.PI_IDE_JS_DEBUG;
test.skipIf(!adapter).each(["JavaScript", "TypeScript"] as const)(
  "real target %s routes reverse child sessions and removes both owned processes",
  async (language) => {
    if (!adapter) throw new Error("Missing explicitly selected JS debug server");
    const fixture = await startSshFixture({}, { PI_JS_DEBUG_PATH: adapter });
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(scope);
    if (!owner) throw new Error("Missing source owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      const typed = language === "TypeScript";
      const native = `${fixture.workspace}/note-café.${typed ? "ts" : "js"}`;
      const code = typed
        ? 'declare const process: { readonly pid: number };\nlet value: number = 42;\nconst pid = process.pid;\nvalue += 1;\nconsole.log("café", value);\n'
        : 'let value = 42;\nconst pid = process.pid;\nvalue += 1;\nconsole.log("café", value);\n';
      await owner.backend.write(native, Buffer.from(code), null);
      let program = native;
      if (typed) {
        const build = await owner.backend.execute(
          "tsc",
          [
            "--sourceMap",
            "--target",
            "ES2022",
            "--module",
            "commonjs",
            "--outDir",
            `${fixture.workspace}/dist`,
            native,
          ],
          fixture.workspace,
        );
        expect(build.exitCode, build.stderr.toString("utf8")).toBe(0);
        program = `${fixture.workspace}/dist/note-café.js`;
      }
      const resource = remoteLocation("fixture", native).source;
      const session = manager.create({
        adapter: "node",
        cwd: scope,
        program: remoteLocation("fixture", program).source,
        sourceFile: resource,
        args: [],
      });
      await manager.addBreakpoint(manager.sourceResource(session), typed ? 4 : 3);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(session.stop?.frame?.source?.path).toBe(resource);
      expect([...session.breakpoints.values()][0]?.verified).toBe(true);
      expect((await manager.evaluate(session, "value")).result).toBe("42");
      const pid = Number((await manager.evaluate(session, "pid")).result);
      expect(Number.isSafeInteger(pid)).toBe(true);
      const loaded = await session.client?.request<{ sources?: { path?: string }[] }>(
        "loadedSources",
      );
      expect(loaded?.sources?.some((source) => source.path?.startsWith("<node_internals>/"))).toBe(
        true,
      );
      const generation = session.stopGeneration;
      await manager.command(session, "next");
      expect(session.stopGeneration).toBeGreaterThan(generation);
      expect((await manager.evaluate(session, "value")).result).toBe("43");
      const adapterPid = session.remote?.pid;
      if (!adapterPid) throw new Error("Missing owned native adapter identity");
      await manager.delete(session.source);
      for (const removed of [pid, adapterPid])
        await expect(readSshProcessMetadata(registry, scope, removed)).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  45000,
);

for (const mismatch of ["peer-pid", "kernel-identity"] as const) {
  test(`Unix DAP refuses ${mismatch} before sending protocol bytes`, async () => {
    const fixture = await startSshFixture();
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const backend = registry.resolve(scope)?.backend;
    if (!backend) throw new Error("Missing source owner");
    try {
      const script = `${fixture.workspace}/unix-peer.py`;
      const socket = `${fixture.workspace}/dap.sock`;
      const marker = `${fixture.workspace}/received.txt`;
      await backend.write(
        script,
        await readFile("tests/integration/fixtures/dap-owner-unix-server.py"),
        null,
      );
      const peer = await backend.startProcess(
        "python3",
        [script, socket, marker],
        fixture.workspace,
      );
      const other = await backend.startProcess(
        "python3",
        ["-c", "import time; time.sleep(60)"],
        fixture.workspace,
      );
      peer.stdout.resume();
      peer.stderr.resume();
      other.stdout.resume();
      other.stderr.resume();
      let client: DapClient | undefined;
      try {
        const selected = mismatch === "peer-pid" ? other : peer;
        if (!selected.identity) throw new Error("Missing native peer identity");
        const identity =
          mismatch === "kernel-identity"
            ? `${selected.identity.split(":")[0]}:0`
            : selected.identity;
        const worker = await readFile("src/backend/dap-unix-worker.py", "utf8");
        const transport = await startSshDapTransport(registry, scope, {
          command: "python3",
          args: ["-c", worker, socket, String(selected.pid), identity],
        });
        client = DapClient.fromTransport(transport);
        await expect(client.request("initialize", {}, { timeoutMs: 5000 })).rejects.not.toThrow(
          /timed out/iu,
        );
        await expect(backend.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        try {
          await client?.dispose();
        } finally {
          await Promise.all([peer.stop(), other.stop()]);
        }
      }
    } finally {
      await fixture.stop();
    }
  }, 15000);
}
