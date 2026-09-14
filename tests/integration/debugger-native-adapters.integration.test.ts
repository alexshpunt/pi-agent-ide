import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { LANGUAGES } from "#src/plugins/pi-agent-ide-languages/src/languages.js";

import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const execute = promisify(execFile);

interface NativeAdapterCase {
  readonly name: "Swift" | "Zig";
  readonly source: string;
  readonly executable: string;
  readonly line: number;
  readonly local: string;
  readonly currentLine: string;
  readonly compile: (cwd: string) => Promise<void>;
}

const cases: readonly NativeAdapterCase[] = [
  {
    name: "Swift",
    source: "main.swift",
    executable: "main-swift",
    line: 5,
    local: "subtotal",
    currentLine: "  print(result)",
    async compile(cwd) {
      await writeFile(
        path.join(cwd, "main.swift"),
        "func total() -> Int {\n  let items = [12, 30]\n  let subtotal = items[0] + items[1]\n  let result = subtotal + 1\n  print(result)\n  return result\n}\n_ = total()\n",
      );
      await execute(
        process.env.PI_SWIFTC_PATH ?? "swiftc",
        ["-g", "-Onone", "main.swift", "-o", "main-swift"],
        { cwd },
      );
    },
  },
  {
    name: "Zig",
    source: "main.zig",
    executable: "main-zig",
    line: 6,
    local: "subtotal",
    currentLine: '    std.debug.print("{d}\\n", .{result});',
    async compile(cwd) {
      await writeFile(
        path.join(cwd, "main.zig"),
        'const std = @import("std");\nfn total(left: i32, right: i32) i32 {\n    var subtotal = left + right;\n    subtotal += 0;\n    const result = subtotal + 1;\n    std.debug.print("{d}\\n", .{result});\n    return result;\n}\npub fn main() void {\n    _ = total(12, 30);\n}\n',
      );
      await execute(
        process.env.PI_ZIG_PATH ?? "zig",
        ["build-exe", "-O", "Debug", "-fllvm", "main.zig", "-femit-bin=main-zig"],
        { cwd },
      );
    },
  },
];

const selected = process.env.PI_DEBUGGER_NATIVE_LANGUAGE?.toLowerCase();
for (const item of cases) {
  test.runIf(selected === item.name.toLowerCase())(
    `provisioned Linux debugger stops in ${item.name} and exposes locals`,
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), `pi-debugger-${item.name.toLowerCase()}-`));
      const manager = new DebugSessionManager();
      try {
        await item.compile(cwd);
        const session = manager.create({
          adapter: "lldb-dap",
          program: path.join(cwd, item.executable),
          sourceFile: path.join(cwd, item.source),
          cwd,
          args: [],
        });
        const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), item.line);

        await manager.start(session);

        expect(session.status).toBe("stopped");
        expect(breakpoint.verified, JSON.stringify(session.stop)).toBe(true);
        expect(session.stop?.frame?.line).toBe(item.line);
        expect(path.resolve(session.stop?.frame?.source?.path ?? "")).toBe(
          path.join(cwd, item.source),
        );
        expect(session.stop?.sourceLines).toContainEqual({
          lineNumber: item.line,
          content: item.currentLine,
          current: true,
        });
        expect(
          session.stop?.variables.some(({ name }) => name === item.local),
          JSON.stringify(session.stop),
        ).toBe(true);

        await manager.command(session, "continue");
        expect(session.status, JSON.stringify(session.stop)).toBe("terminated");

        const doctor = await runDebuggerDoctor(cwd);
        const language = item.name.toLowerCase();
        expect(doctor.selections).toContainEqual(
          expect.objectContaining({ kind: "debugger", languageId: language }),
        );
        expect(
          doctor.actions.filter(({ id }) => id.startsWith(`debugger-lldb-dap-${language}`)),
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
}

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
