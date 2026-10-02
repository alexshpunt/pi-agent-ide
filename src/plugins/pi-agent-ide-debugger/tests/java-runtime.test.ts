import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  JavaDebugRuntime,
  javaDebuggerFiles,
} from "#src/plugins/pi-agent-ide-debugger/src/java-runtime.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

async function files(root: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await mkdir(path.join(root, process.platform === "win32" ? "config_win" : "config_linux"));
  await writeFile(path.join(root, "plugins/org.eclipse.equinox.launcher_test.jar"), "fixture");
  const plugin = path.join(root, "java-debug.jar");
  await writeFile(plugin, "fixture");
  return { ...process.env, PI_JDTLS_HOME: root, PI_JAVA_DEBUG_PLUGIN_PATH: plugin };
}

test("missing Java bridge files report configuration guidance without starting any JVM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-java-missing-"));
  const runtime = new JavaDebugRuntime();
  try {
    await expect(
      runtime.connect(root, AbortSignal.timeout(1_000), {
        PI_JDTLS_HOME: root,
        PI_JAVA_DEBUG_PLUGIN_PATH: path.join(root, "missing.jar"),
      }),
    ).rejects.toThrow(/PI_JDTLS_HOME.*PI_JAVA_DEBUG_PLUGIN_PATH/u);
    expect(runtime.processIds).toEqual([]);
    await runtime.close();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid Java executable fails promptly and cleanup remains idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-java-invalid-"));
  const runtime = new JavaDebugRuntime();
  try {
    const env = await files(root);
    env.PI_JAVA_PATH = path.join(root, "missing-java");
    await expect(runtime.connect(root, AbortSignal.timeout(1_000), env)).rejects.toThrow(/ENOENT/u);
    expect(runtime.processIds).toEqual([]);
    await runtime.close();
    await runtime.close();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uncompiled Java launch keeps its configured session and breakpoint without owning a JVM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-java-uncompiled-"));
  const source = path.join(root, "Main.java");
  const manager = new DebugSessionManager();
  try {
    await writeFile(source, "public class Main {}\n");
    const session = manager.create({
      adapter: "java",
      program: source,
      sourceFile: source,
      cwd: root,
      args: [],
      mainClass: "Main",
    });
    await manager.addBreakpoint(manager.sourceResource(session), 1);
    const starting = manager.start(session, AbortSignal.timeout(1_000));
    const runtime = session.javaRuntime;
    await expect(starting).rejects.toThrow(/Main is not compiled/u);
    expect(runtime?.processIds).toEqual([]);
    expect(session.status).toBe("configured");
    expect(session.breakpoints.size).toBe(1);
    expect(session.client).toBeUndefined();
    expect(session.javaRuntime).toBeUndefined();
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("native Windows configuration is validated independently of the Kotlin adapter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-java-win-"));
  try {
    const env = await files(root);
    await mkdir(path.join(root, "config_win"), { recursive: true });
    expect((await javaDebuggerFiles(env, "win32")).configuration).toBe(
      path.join(root, "config_win"),
    );
    await rm(env.PI_JAVA_DEBUG_PLUGIN_PATH as string);
    await expect(javaDebuggerFiles(env, "win32")).rejects.toThrow(/PI_JAVA_DEBUG_PLUGIN_PATH/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
