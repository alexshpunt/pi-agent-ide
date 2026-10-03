import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { JavaDebugRuntime } from "#src/plugins/pi-agent-ide-debugger/src/java-runtime.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const execute = promisify(execFile);
const enabled = process.env.PI_DEBUGGER_JVM_LANGUAGE === "java";
const sourceText =
  'public class Main {\n  public static void main(String[] args) {\n    int subtotal = 12 + 30;\n    int result = subtotal + 1;\n    System.out.println(result);\n  }\n  static { try { java.nio.file.Files.writeString(java.nio.file.Path.of("executed"), "ran"); } catch (java.io.IOException e) { throw new RuntimeException(e); } }\n}\n';

async function fixture(): Promise<{ cwd: string; source: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi java lifecycle "));
  const source = path.join(cwd, "src/main/java/Main.java");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.join(cwd, "build/classes/java/main"), { recursive: true });
  await writeFile(source, sourceText);
  await execute(
    process.env.PI_JAVAC_PATH ?? "javac",
    ["-g", "-d", "build/classes/java/main", "src/main/java/Main.java"],
    { cwd },
  );
  return { cwd, source };
}

function expectGone(pids: readonly number[]): void {
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
}

test.runIf(enabled).each([1, 2, 3, 4, 5])(
  "fresh Java session %i keeps its first stop and cleans up both JVMs",
  async () => {
    const { cwd, source } = await fixture();
    const manager = new DebugSessionManager();
    const session = manager.create({
      adapter: "java",
      program: source,
      sourceFile: source,
      cwd,
      args: [],
      mainClass: "Main",
    });
    try {
      const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 4);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      expect(breakpoint.verified).toBe(true);
      expect(session.stop?.frame?.line).toBe(4);
      expect(path.resolve(session.stop?.frame?.source?.path ?? "")).toBe(source);
      expect(session.stop?.sourceLines).toContainEqual({
        lineNumber: 4,
        content: "    int result = subtotal + 1;",
        current: true,
      });
      expect(session.stop?.variables).toContainEqual(
        expect.objectContaining({ name: "subtotal", value: "42" }),
      );
      const pids = session.javaRuntime?.processIds ?? [];
      await manager.command(session, "continue");
      expect(session.status).toBe("terminated");
      expectGone(pids);
      await manager.delete(session.source);
      expect(manager.get(session.source)).toBeUndefined();
    } finally {
      await session.javaRuntime?.close();
      await manager.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

test.runIf(enabled)(
  "Java does not run user code before attach and configurationDone",
  async () => {
    const { cwd, source } = await fixture();
    const runtime = new JavaDebugRuntime();
    try {
      const signal = AbortSignal.timeout(25_000);
      const { client, attach } = await runtime.start(
        { adapter: "java", program: source, sourceFile: source, cwd, args: [], mainClass: "Main" },
        signal,
      );
      const marker = path.join(cwd, "executed");
      await expect(access(marker)).rejects.toThrow(/ENOENT/u);
      await client.request(
        "initialize",
        { adapterID: "java", pathFormat: "path", linesStartAt1: true, columnsStartAt1: true },
        { signal },
      );
      await Promise.all([
        client.waitForAnyEvent(["initialized"], 10_000, signal),
        client.request("attach", attach, { signal }),
      ]);
      await client.request(
        "setBreakpoints",
        { source: { path: source }, breakpoints: [{ line: 4 }] },
        { signal },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(access(marker)).rejects.toThrow(/ENOENT/u);
      await client.request("configurationDone", undefined, { signal });
      const stop = await client.waitForAnyEvent(["stopped", "terminated"], 10_000, signal);
      expect(stop.event).toBe("stopped");
      expect(await readFile(marker, "utf8")).toBe("ran");
      const pids = runtime.processIds;
      await runtime.close();
      expectGone(pids);
    } finally {
      await runtime.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

test.runIf(enabled)(
  "Pi shutdown waits for both owned Java processes while stopped",
  async () => {
    const { cwd, source } = await fixture();
    const manager = new DebugSessionManager();
    const session = manager.create({
      adapter: "java",
      program: source,
      sourceFile: source,
      cwd,
      args: [],
      mainClass: "Main",
    });
    try {
      await manager.addBreakpoint(manager.sourceResource(session), 4);
      await manager.start(session);
      expect(session.status).toBe("stopped");
      const pids = session.javaRuntime?.processIds ?? [];
      await manager.dispose();
      expectGone(pids);
      expect(manager.get(session.source)).toBeUndefined();
    } finally {
      await manager.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

test.runIf(enabled)(
  "Java cancellation stops an owned server even before DAP is ready",
  async () => {
    const runtime = new JavaDebugRuntime();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    try {
      const connecting = runtime.connect(process.cwd(), signal);
      const rejected = expect(connecting).rejects.toThrow("cancel Java startup");
      while (runtime.processIds.length === 0 && !signal.aborted)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(new Error("cancel Java startup"));
      await rejected;
      const pids = runtime.processIds;
      expect(pids).toHaveLength(1);
      await runtime.close();
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
    } finally {
      await runtime.close();
    }
  },
  10_000,
);
