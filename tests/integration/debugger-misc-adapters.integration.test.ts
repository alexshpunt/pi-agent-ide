import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
import {
  DebugSessionManager,
  type DebugAdapter,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

interface MiscAdapterCase {
  readonly language: string;
  readonly name: string;
  readonly adapter: DebugAdapter;
  readonly program: string;
  readonly source: string;
  readonly line: number;
  readonly sourceLine: string;
  readonly local: string;
  readonly recipe: string;
  readonly prepare: (cwd: string) => Promise<void>;
}

const cases: readonly MiscAdapterCase[] = [
  {
    language: "elixir",
    name: "Elixir",
    adapter: "elixir",
    program: "runner.exs",
    source: "lib/main.ex",
    line: 4,
    sourceLine: "    subtotal = Enum.sum(items)",
    local: "items",
    recipe: "elixir-ls-debug-adapter",
    async prepare(cwd) {
      await mkdir(path.join(cwd, "lib"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(cwd, "mix.exs"),
          'defmodule DebugFixture.MixProject do\n  use Mix.Project\n  def project, do: [app: :debug_fixture, version: "0.1.0", elixir: "~> 1.14"]\n  def application, do: [extra_applications: [:logger]]\nend\n',
        ),
        writeFile(
          path.join(cwd, "lib/main.ex"),
          "defmodule Main do\n  def total do\n    items = [12, 30]\n    subtotal = Enum.sum(items)\n    result = subtotal + 1\n    IO.puts(result)\n  end\nend\n",
        ),
        writeFile(path.join(cwd, "runner.exs"), "Main.total()\n"),
      ]);
    },
  },
  {
    language: "r",
    name: "R",
    adapter: "r",
    program: "main.R",
    source: "main.R",
    line: 4,
    sourceLine: "  result <- subtotal + 1",
    local: "subtotal",
    recipe: "vsc-debugger",
    async prepare(cwd) {
      await writeFile(
        path.join(cwd, "main.R"),
        "total <- function() {\n  items <- c(12, 30)\n  subtotal <- sum(items)\n  result <- subtotal + 1\n  print(result)\n}\ntotal()\n",
      );
    },
  },
  {
    language: "julia",
    name: "Julia",
    adapter: "julia",
    program: "main.jl",
    source: "main.jl",
    line: 4,
    sourceLine: "    result = subtotal + 1",
    local: "subtotal",
    recipe: "julia-debug-adapter",
    async prepare(cwd) {
      await writeFile(
        path.join(cwd, "main.jl"),
        "function total()\n    items = [12, 30]\n    subtotal = sum(items)\n    result = subtotal + 1\n    println(result)\nend\ntotal()\n",
      );
    },
  },
];

const selected = process.env.PI_DEBUGGER_MISC_LANGUAGE?.toLowerCase();
test("defines the miscellaneous debugger cases", () => {
  expect(cases).toHaveLength(3);
});
for (const item of cases.filter(({ language }) => language === selected)) {
  test(`provisioned Linux debugger stops in ${item.name} and exposes locals`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), `pi-debugger-${item.language}-`));
    const manager = new DebugSessionManager();
    try {
      await item.prepare(cwd);
      const session = manager.create({
        adapter: item.adapter,
        program: path.join(cwd, item.program),
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
        content: item.sourceLine,
        current: true,
      });
      expect(
        session.stop?.variables.some(({ name }) => name === item.local),
        JSON.stringify(session.stop),
      ).toBe(true);

      await manager.command(session, "continue");
      expect(session.status, JSON.stringify(session.stop)).toBe("terminated");

      const doctor = await runDebuggerDoctor(cwd);
      expect(doctor.selections).toContainEqual(
        expect.objectContaining({
          kind: "debugger",
          languageId: item.language,
          toolId: item.recipe,
        }),
      );
      expect(doctor.actions.filter(({ id }) => id.startsWith(`debugger-${item.recipe}`))).toEqual(
        [],
      );
      expect(
        doctor.sections
          .find(({ pluginId }) => pluginId === "debugger")
          ?.findings.filter(({ status }) => status !== "pass"),
      ).toEqual([]);
    } finally {
      manager.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
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
