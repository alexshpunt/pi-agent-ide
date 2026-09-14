import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";
import {
  DOCTOR_API_VERSION,
  DOCTOR_PROTOCOL,
  type DoctorPlugin,
} from "pi-agent-doctor/api/plugin-protocol";

import { DoctorCore } from "#src/doctor/core.js";
import { runDoctor } from "#src/doctor/run.js";
import { debuggerDoctorPlugin } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import { LANGUAGES } from "#src/plugins/pi-agent-ide-languages/src/languages.js";

const execute = promisify(execFile);

const selected = process.env.PI_DEBUGGER_JVM_LANGUAGE;

test.runIf(selected === "java")(
  "provisioned Linux debugger stops in Java and exposes locals",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-debugger-java-"));
    const manager = new DebugSessionManager();
    try {
      const source = path.join(cwd, "src/main/java/Main.java");
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(path.join(cwd, "build/classes/java/main"), { recursive: true });
      await writeFile(
        source,
        "public class Main {\n  public static void main(String[] args) {\n    int subtotal = 12 + 30;\n    int result = subtotal + 1;\n    System.out.println(result);\n  }\n}\n",
      );
      await execute(
        process.env.PI_JAVAC_PATH ?? "javac",
        ["-g", "-d", "build/classes/java/main", "src/main/java/Main.java"],
        { cwd },
      );

      const session = manager.create({
        adapter: "java",
        program: source,
        sourceFile: source,
        cwd,
        args: [],
        mainClass: "Main",
      });
      const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), 4);

      await manager.start(session);

      expect(session.status).toBe("stopped");
      expect(breakpoint.verified, JSON.stringify(session.stop)).toBe(true);
      expect(session.stop?.frame?.line).toBe(4);
      expect(path.resolve(session.stop?.frame?.source?.path ?? "")).toBe(source);
      expect(session.stop?.sourceLines).toContainEqual({
        lineNumber: 4,
        content: "    int result = subtotal + 1;",
        current: true,
      });
      expect(
        session.stop?.variables.some(({ name }) => name === "subtotal"),
        JSON.stringify(session.stop),
      ).toBe(true);

      await manager.command(session, "continue");
      expect(session.status, JSON.stringify(session.stop)).toBe("terminated");

      const doctor = await runDebuggerDoctor(cwd);
      expect(doctor.selections).toContainEqual(
        expect.objectContaining({
          kind: "debugger",
          languageId: "java",
          toolId: "kotlin-debug-adapter",
        }),
      );
      expect(
        doctor.actions.filter(({ id }) => id.startsWith("debugger-kotlin-debug-adapter")),
      ).toEqual([]);
      expect(
        doctor.sections
          .find(({ pluginId }) => pluginId === "debugger")
          ?.findings.filter(({ status }) => status !== "pass"),
      ).toEqual([]);
    } finally {
      manager.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);

async function runDebuggerDoctor(cwd: string): ReturnType<typeof runDoctor> {
  const languagePlugin = {
    protocol: DOCTOR_PROTOCOL,
    apiVersion: DOCTOR_API_VERSION,
    id: "languages",
    setup(api): void {
      for (const language of LANGUAGES) api.addLanguage(language);
    },
  } satisfies DoctorPlugin;
  const core = new DoctorCore();
  await core.registerPlugin(languagePlugin);
  await core.registerPlugin(debuggerDoctorPlugin);
  return runDoctor(core.snapshot(), cwd, process.env);
}
