import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const rdbgExecutable = process.env.PI_IDE_RDBG;
test.skipIf(!rdbgExecutable)(
  "real target Ruby uses its owned loopback adapter and removes its debuggee",
  async () => {
    if (!rdbgExecutable) throw new Error("Missing explicit rdbg executable");
    const fixture = await startSshFixture({ rdbg: rdbgExecutable });
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(scope);
    if (!owner) throw new Error("Missing source owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      const program = `${fixture.workspace}/note.rb`;
      await owner.backend.write(
        program,
        Buffer.from("value = 42\npid = Process.pid\nvalue += 1\nputs value\n"),
        null,
      );
      const resource = remoteLocation("fixture", program).source;
      const session = manager.create({ adapter: "ruby", cwd: scope, program: resource, args: [] });
      await manager.addBreakpoint(manager.sourceResource(session), 3);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(session.stop?.frame?.source?.path).toBe(resource);
      expect([...session.breakpoints.values()][0]?.verified).toBe(true);
      expect((await manager.evaluate(session, "value")).result).toBe("42");
      const pid = Number((await manager.evaluate(session, "pid")).result);
      expect(Number.isSafeInteger(pid)).toBe(true);
      await manager.command(session, "next");
      expect((await manager.evaluate(session, "value")).result).toBe("43");
      await manager.delete(session.source);
      await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  30000,
);

const delveExecutable = process.env.PI_IDE_DELVE;
test.skipIf(!delveExecutable)(
  "real target Delve uses its owned loopback adapter and removes its debuggee",
  async () => {
    if (!delveExecutable) throw new Error("Missing explicit Delve executable");
    const fixture = await startSshFixture(
      { dlv: delveExecutable },
      { GOCACHE: "{workspace}/go-cache", GOPATH: "{workspace}/go-path" },
    );
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const scope = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(scope);
    if (!owner) throw new Error("Missing source owner");
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    try {
      const program = `${fixture.workspace}/note.go`;
      await owner.backend.write(
        program,
        Buffer.from(
          'package main\nimport "fmt"\nimport "os"\nfunc main() {\n  value := 42\n  pid := os.Getpid()\n  value++\n  fmt.Println(value, pid)\n}\n',
        ),
        null,
      );
      // Populate only the fixture cache before starting the adapter, without extending its deadline.
      const build = await owner.backend.execute(
        "go",
        ["build", "-gcflags=all=-N -l", "-o", `${fixture.workspace}/compiled-note`, program],
        fixture.workspace,
      );
      expect(build.exitCode, build.stderr.toString("utf8")).toBe(0);
      const resource = remoteLocation("fixture", program).source;
      const session = manager.create({ adapter: "delve", cwd: scope, program: resource, args: [] });
      await manager.addBreakpoint(manager.sourceResource(session), 7);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(session.stop?.frame?.source?.path).toBe(resource);
      expect([...session.breakpoints.values()][0]?.verified).toBe(true);
      expect((await manager.evaluate(session, "value")).result).toBe("42");
      const pid = Number((await manager.evaluate(session, "pid")).result);
      expect(Number.isSafeInteger(pid)).toBe(true);
      await manager.command(session, "next");
      expect((await manager.evaluate(session, "value")).result).toBe("43");
      await manager.delete(session.source);
      await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  90000,
);
