import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const enabled = process.platform === "linux" && process.env.PI_DEBUGGER_JVM_LANGUAGE === "java";

test.runIf(enabled)(
  "SSH Java uses JDT LS and java-debug, binds canonical source stops and removes its owned process tree",
  async () => {
    const java = process.env.PI_JAVA_PATH;
    const javac = process.env.PI_JAVAC_PATH;
    const home = process.env.PI_JDTLS_HOME;
    const plugin = process.env.PI_JAVA_DEBUG_PLUGIN_PATH;
    if (!java || !javac || !home || !plugin)
      throw new Error("Provision the pinned Java debugger before this test");
    const fixture = await startSshFixture(
      {},
      {
        PI_JAVA_PATH: java,
        PI_JDTLS_HOME: "{workspace}/jdtls",
        PI_JAVA_DEBUG_PLUGIN_PATH: "{workspace}/java-debug.jar",
      },
    );
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const root = `ssh://fixture${fixture.workspace}`;
    const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
    const owner = registry.resolve(root);
    if (!owner) throw new Error("Missing SSH owner");
    const source = `${root}/src/main/java/Main.java`;
    try {
      await cp(home, path.join(fixture.workspace, "jdtls"), { recursive: true });
      await writeFile(path.join(fixture.workspace, "java-debug.jar"), await readFile(plugin));
      const prepared = await owner.backend.execute(
        "mkdir",
        ["-p", "src/main/java", "build/classes/java/main"],
        fixture.workspace,
      );
      expect(prepared.exitCode).toBe(0);
      await owner.backend.write(
        path.join(fixture.workspace, "src/main/java/Main.java"),
        Buffer.from(
          'public class Main {\n  public static void main(String[] args) {\n    int value = 42;\n    value += 1;\n    System.out.println("café " + value);\n  }\n}\n',
        ),
        null,
      );
      const compiled = await owner.backend.execute(
        javac,
        ["-g", "-d", "build/classes/java/main", "src/main/java/Main.java"],
        fixture.workspace,
      );
      expect(compiled.exitCode).toBe(0);
      const session = manager.create({
        adapter: "java",
        cwd: root,
        program: source,
        sourceFile: source,
        mainClass: "Main",
        args: [],
      });
      const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 4);
      await manager.start(session, AbortSignal.timeout(40_000));
      expect(session.javaRuntime).toBeUndefined();
      expect(session.remote?.target).toBe("fixture");
      expect(session.status).toBe("stopped");
      expect(breakpoint.verified).toBe(true);
      expect(session.stop?.frame?.source?.path).toBe(source);
      expect(session.stop?.frame?.line).toBe(4);
      expect(session.stop?.variables).toContainEqual(
        expect.objectContaining({ name: "value", value: "42" }),
      );
      await manager.command(session, "next");
      expect(session.stop?.variables).toContainEqual(
        expect.objectContaining({ name: "value", value: "43" }),
      );
      const remote = session.remote;
      if (!remote) throw new Error("Missing remote Java owner");
      await manager.delete(session.source);
      await expect(readSshProcessMetadata(registry, root, remote.pid)).rejects.toThrow(/ENOENT/u);
    } finally {
      await manager.dispose();
      await fixture.stop();
    }
  },
  90_000,
);
