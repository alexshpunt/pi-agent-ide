import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const selected = process.env.PI_IDE_PROVISIONED_LANGUAGE;
const cases = [
  {
    language: "elixir",
    adapter: "elixir",
    file: "lib/main.ex",
    line: 4,
    code: 'defmodule Main do\n  def total do\n    value = 42\n    value = value + 1\n    IO.puts("café #{value}")\n  end\nend\n',
  },
  {
    language: "dart",
    adapter: "dart",
    file: "note.dart",
    line: 3,
    code: 'void main() {\n  var value = 42;\n  value += 1;\n  print("café $value");\n}\n',
  },
  {
    language: "csharp",
    adapter: "netcoredbg",
    file: "Program.cs",
    line: 3,
    code: 'using System;\nint value = 42;\nvalue += 1;\nConsole.WriteLine($"café {value}");\n',
  },
  {
    language: "java",
    adapter: "java",
    file: "src/main/java/Main.java",
    line: 4,
    code: 'public class Main {\n  public static void main(String[] args) {\n    int value = 42;\n    value += 1;\n    System.out.println("café " + value);\n  }\n}\n',
  },
  {
    language: "kotlin",
    adapter: "kotlin",
    file: "src/main/kotlin/Main.kt",
    line: 3,
    code: 'fun main() {\n  var value = 42\n  value += 1\n  println("café $value")\n}\n',
  },
  {
    language: "swift",
    adapter: "lldb-dap",
    file: "note.swift",
    line: 3,
    code: 'func run() {\n  var value = 42\n  value += 1\n  print("café \\(value)")\n}\nrun()\n',
  },
  {
    language: "zig",
    adapter: "lldb-dap",
    file: "note.zig",
    line: 4,
    code: 'const std = @import("std");\npub fn main() void {\n    var value: i32 = 42;\n    value += 1;\n    std.debug.print("café {d}\\n", .{value});\n}\n',
  },
] as const;

async function readReceipt(): Promise<{
  root: string;
  runtime: string;
  environment: Record<string, string>;
}> {
  const file = process.env.PI_IDE_DEBUGGER_RECEIPT;
  if (!file) throw new Error("Select an explicitly provisioned private debugger receipt");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    !("runtime" in value) ||
    typeof value.runtime !== "string" ||
    !("environment" in value) ||
    typeof value.environment !== "object" ||
    value.environment === null
  )
    throw new Error("Invalid private debugger receipt");
  const environment: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.environment)) {
    if (typeof item !== "string") throw new Error("Invalid fixture environment value");
    environment[key] = item;
  }
  return { root: value.root, runtime: value.runtime, environment };
}

for (const item of cases) {
  test.runIf(selected === item.language)(
    `installed target ${item.language} verifies canonical breakpoints, steps 42 to 43 and removes its owned tree`,
    async () => {
      const receipt = await readReceipt();
      const environment = { ...receipt.environment };
      // The SSH fixture owns PATH; native compiler and adapter paths are selected explicitly.
      delete environment.PATH;
      // Keep VM account caches inside the approved private toolchain home.
      if (item.language === "java" || item.language === "kotlin")
        environment.JAVA_TOOL_OPTIONS = `-Duser.home=${environment.HOME}`;
      if (item.language === "elixir") {
        delete environment.ERL_FLAGS;
        environment.PI_ELIXIR_LS_DEBUG_PATH = "{workspace}/elixir-adapter";
        environment.LANG = "C.UTF-8";
      }
      // The selected runtime and adapters are native target paths, never controller fallbacks.
      if (item.language === "dart") environment.PI_DART_PATH = receipt.runtime;
      if (item.language === "csharp") environment.PI_NETCOREDBG_PATH = "{workspace}/netcoredbg";
      if (item.language === "java" || item.language === "kotlin")
        environment.PI_KOTLIN_DEBUG_ADAPTER_PATH = `${receipt.root}/adapter/adapter/bin/kotlin-debug-adapter`;
      if (item.language === "swift")
        environment.PI_SWIFT_LLDB_DAP_PATH = receipt.runtime.replace(/swiftc$/u, "lldb-dap");
      const fixture = await startSshFixture({}, environment);
      const registry = new SshBackendRegistry([
        {
          id: "fixture",
          host: "fixture",
          workspace: fixture.workspace,
          configFile: fixture.config,
        },
      ]);
      const scope = `ssh://fixture${fixture.workspace}`;
      const owner = registry.resolve(scope);
      if (!owner) throw new Error("Missing source owner");
      const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
      try {
        const native = `${fixture.workspace}/${item.file}`;
        const source = remoteLocation("fixture", native).source;
        const code = item.code.replaceAll("\n", "\r\n");
        let program = native;
        const compile = async (command: string, args: string[]): Promise<void> => {
          const result = await owner.backend.execute(command, args, fixture.workspace);
          expect(
            result.exitCode,
            result.stderr.toString("utf8") + result.stdout.toString("utf8"),
          ).toBe(0);
        };
        if (item.language === "java" || item.language === "kotlin")
          await compile("mkdir", [
            "-p",
            `${fixture.workspace}/src/main/${item.language}`,
            `${fixture.workspace}/build/classes/${item.language}/main`,
          ]);
        if (item.language === "elixir") await compile("mkdir", ["-p", `${fixture.workspace}/lib`]);
        await owner.backend.write(native, Buffer.from(code), null);
        if (item.language === "elixir") {
          await owner.backend.write(
            `${fixture.workspace}/elixir-adapter`,
            Buffer.from(
              `#!/bin/sh\nexport PATH="${receipt.environment.PATH}"\nexport ERL_FLAGS="+S 2:2"\nexec "${receipt.root}/elixir-ls/debug_adapter.sh" "$@"\n`,
            ),
            null,
          );
          await compile("chmod", ["755", `${fixture.workspace}/elixir-adapter`]);
          await owner.backend.write(
            `${fixture.workspace}/mix.exs`,
            Buffer.from(
              'defmodule DebugFixture.MixProject do\n  use Mix.Project\n  def project, do: [app: :debug_fixture, version: "0.1.0", elixir: "~> 1.18"]\n  def application, do: [extra_applications: [:logger]]\nend\n',
            ),
            null,
          );
          program = `${fixture.workspace}/runner.exs`;
          await owner.backend.write(program, Buffer.from("Main.total()\r\n"), null);
        }
        if (item.language === "csharp") {
          await owner.backend.write(
            `${fixture.workspace}/netcoredbg`,
            Buffer.from(
              `#!/bin/sh\nexport PATH="${receipt.root}/dotnet:$PATH"\nexec "${receipt.root}/netcoredbg/netcoredbg/netcoredbg" "$@"\n`,
            ),
            null,
          );
          await compile("chmod", ["755", `${fixture.workspace}/netcoredbg`]);
          await owner.backend.write(
            `${fixture.workspace}/Native.csproj`,
            Buffer.from(
              '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><DebugType>portable</DebugType></PropertyGroup></Project>',
            ),
            null,
          );
          await owner.backend.write(
            `${fixture.workspace}/NuGet.Config`,
            Buffer.from("<configuration><packageSources><clear/></packageSources></configuration>"),
            null,
          );
          await compile(receipt.runtime, ["build", "Native.csproj", "-c", "Debug", "--nologo"]);
          program = `${fixture.workspace}/bin/Debug/net8.0/Native.dll`;
        } else if (item.language === "java") {
          await compile(receipt.runtime.replace(/java$/u, "javac"), [
            "-g",
            "-d",
            "build/classes/java/main",
            item.file,
          ]);
        } else if (item.language === "kotlin") {
          await compile(`${receipt.root}/kotlin/kotlinc/bin/kotlinc`, [
            item.file,
            "-d",
            "build/classes/kotlin/main",
          ]);
        } else if (item.language === "swift" || item.language === "zig") {
          program = `${fixture.workspace}/native-program`;
          await compile(
            receipt.runtime,
            item.language === "swift"
              ? ["-g", "-Onone", native, "-o", program]
              : ["build-exe", "-O", "Debug", "-fllvm", native, `-femit-bin=${program}`],
          );
        }
        const session = manager.create({
          adapter: item.adapter,
          cwd: scope,
          program: remoteLocation("fixture", program).source,
          sourceFile: source,
          args: [],
          ...(item.language === "java" || item.language === "kotlin"
            ? { mainClass: item.language === "java" ? "Main" : "MainKt" }
            : {}),
        });
        const breakpoint = await manager.addBreakpoint(manager.sourceResource(session), item.line);
        const events: unknown[] = [];
        const observed = new Set<object>();
        const detach = manager.onDidChange(() => {
          const client = session.client;
          if (!client || observed.has(client)) return;
          observed.add(client);
          client.onEvent((event) => events.push(event));
        });
        try {
          await manager.start(session);
        } catch (error) {
          console.error(JSON.stringify({ language: item.language, nativeEvents: events }));
          throw error;
        } finally {
          detach();
        }
        expect(session.status, JSON.stringify(session.stop)).toBe("stopped");
        expect(breakpoint.verified, JSON.stringify(session.stop)).toBe(true);
        expect(session.stop?.frame?.source?.path).toBe(source);
        expect(session.stop?.frame?.line).toBe(item.line);
        expect(session.stop?.variables.find(({ name }) => name === "value")?.value).toBe("42");
        const generation = session.stopGeneration;
        await manager.command(session, "next");
        expect(session.stopGeneration).toBeGreaterThan(generation);
        expect(session.stop?.variables.find(({ name }) => name === "value")?.value).toBe("43");
        const adapterPid = session.remote?.pid;
        if (!adapterPid) throw new Error("Missing native adapter ownership");
        const tree = await owner.backend.execute(
          "python3",
          [
            "-c",
            "import pathlib,sys,json\nseen=set(); todo=[int(sys.argv[1])]\nwhile todo:\n p=todo.pop()\n if p in seen: continue\n seen.add(p)\n try:\n  for task in pathlib.Path('/proc/'+str(p)+'/task').iterdir():\n   try: todo.extend(map(int,(task/'children').read_text().split()))\n   except FileNotFoundError: pass\n except FileNotFoundError: pass\nprint(json.dumps(sorted(seen)))",
            String(adapterPid),
          ],
          fixture.workspace,
        );
        expect(tree.exitCode).toBe(0);
        const pids: unknown = JSON.parse(tree.stdout.toString("utf8"));
        if (!Array.isArray(pids) || !pids.every((pid): pid is number => Number.isSafeInteger(pid)))
          throw new Error("Invalid exact owned tree receipt");
        expect(pids.length).toBeGreaterThan(1);
        await manager.delete(session.source);
        for (const pid of pids)
          await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
            code: "ENOENT",
          });
        expect((await owner.backend.read(native)).bytes.toString("utf8")).toBe(code);
      } finally {
        await manager.dispose();
        await fixture.stop();
      }
    },
    90000,
  );
}
