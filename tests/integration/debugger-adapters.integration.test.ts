import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, test } from "vitest";
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

const execute = promisify(execFile);
const selectedAdapter = process.env.PI_DEBUGGER_CORE_ADAPTER;
const excludedAdapter = process.env.PI_DEBUGGER_CORE_EXCLUDE_ADAPTER;
const matrixProvisioned = spawnSync("kotlinc", ["-version"], { stdio: "ignore" }).status === 0;
let workspace = "";

interface AdapterCase {
  readonly name: string;
  readonly adapter: DebugAdapter;
  readonly program: string;
  readonly source: string;
  readonly line: number;
  readonly local: string;
  readonly mainClass?: string;
}

beforeAll(async () => {
  if (!matrixProvisioned) return;
  workspace = await mkdtemp(path.join(tmpdir(), "pi-debugger-matrix-"));
  await prepareFixtures(workspace, selectedAdapter, excludedAdapter);
}, 60_000);

afterAll(async () => {
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

const cases: readonly AdapterCase[] = [
  {
    name: "Python",
    adapter: "debugpy",
    program: "main.py",
    source: "main.py",
    line: 4,
    local: "subtotal",
  },
  {
    name: "C++",
    adapter: "lldb-dap",
    program: "main-cpp",
    source: "main.cpp",
    line: 4,
    local: "subtotal",
  },
  {
    name: "Rust",
    adapter: "lldb-dap",
    program: "main-rust",
    source: "main.rs",
    line: 4,
    local: "subtotal",
  },
  {
    name: "Dart",
    adapter: "dart",
    program: "main.dart",
    source: "main.dart",
    line: 4,
    local: "subtotal",
  },
  {
    name: "Go",
    adapter: "delve",
    program: "main.go",
    source: "main.go",
    line: 6,
    local: "subtotal",
  },
  {
    name: "Kotlin",
    adapter: "kotlin",
    program: "src/main/kotlin/Main.kt",
    source: "src/main/kotlin/Main.kt",
    line: 4,
    local: "subtotal",
    mainClass: "MainKt",
  },
  {
    name: "C#",
    adapter: "netcoredbg",
    program: "csharp/bin/Debug/net8.0/debug-matrix.dll",
    source: "csharp/Program.cs",
    line: 7,
    local: "subtotal",
  },
  {
    name: "JavaScript",
    adapter: "node",
    program: "main.js",
    source: "main.js",
    line: 4,
    local: "subtotal",
  },
  {
    name: "TypeScript",
    adapter: "node",
    program: "main.ts",
    source: "main.ts",
    line: 4,
    local: "subtotal",
  },
  {
    name: "transpiled TypeScript source maps",
    adapter: "node",
    program: "dist/main.js",
    source: "src/main.ts",
    line: 3,
    local: "items",
  },
  {
    name: "Ruby",
    adapter: "ruby",
    program: "main.rb",
    source: "main.rb",
    line: 4,
    local: "subtotal",
  },
  {
    name: "PHP",
    adapter: "php",
    program: "main.php",
    source: "main.php",
    line: 5,
    local: "$subtotal",
  },
  {
    name: "Lua",
    adapter: "lua",
    program: "main.lua",
    source: "main.lua",
    line: 4,
    local: "subtotal",
  },
  {
    name: "Shell",
    adapter: "shell",
    program: "main.sh",
    source: "main.sh",
    line: 4,
    local: "$PWD",
  },
  {
    name: "PowerShell",
    adapter: "powershell",
    program: "main.ps1",
    source: "main.ps1",
    line: 4,
    local: "subtotal",
  },
];

for (const item of cases) {
  test.runIf(
    matrixProvisioned &&
      (selectedAdapter === undefined || item.adapter === selectedAdapter) &&
      item.adapter !== excludedAdapter,
  )(
    `provisioned Linux debugger stops in ${item.name} and exposes locals`,
    async () => {
      const manager = new DebugSessionManager();
      const session = manager.create({
        adapter: item.adapter,
        program: path.join(workspace, item.program),
        sourceFile: path.join(workspace, item.source),
        cwd: workspace,
        args: [],
        ...(item.mainClass === undefined ? {} : { mainClass: item.mainClass }),
      });
      try {
        const source = manager.sourceResource(session);
        const breakpoint = await manager.addBreakpoint(source, item.line);
        await manager.start(session);
        expect(session.status).toBe("stopped");
        expect(breakpoint.verified, JSON.stringify(session.stop)).toBe(true);
        expect(session.stop?.frame?.line).toBe(item.line);
        expect(session.stop?.frame?.source?.path).toEqual(
          expect.stringContaining(path.basename(item.source)),
        );
        expect(
          session.stop?.sourceLines.some(
            ({ lineNumber, current }) => lineNumber === item.line && current,
          ),
        ).toBe(true);
        expect(
          session.stop?.variables.some(
            ({ name }) => name.replace(/^\$/u, "") === item.local.replace(/^\$/u, ""),
          ),
          JSON.stringify(session.stop),
        ).toBe(true);
        await manager.command(session, "continue");
        expect(session.status, JSON.stringify(session.stop)).toBe("terminated");
      } finally {
        await manager.delete(session.source);
        manager.dispose();
      }
    },
    45_000,
  );
}

test.runIf(matrixProvisioned && selectedAdapter === undefined)(
  "Doctor selects and probes every provisioned scripting debugger",
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-debugger-doctor-"));
    try {
      await Promise.all(
        ["main.rb", "main.php", "main.lua", "main.sh", "main.ps1"].map((file) =>
          writeFile(path.join(cwd, file), "fixture\n"),
        ),
      );
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

      const result = await runDoctor(core.snapshot(), cwd, process.env);
      const scriptingLanguages = new Set(["ruby", "php", "lua", "shell", "powershell"]);
      expect(
        result.selections
          .filter(({ languageId }) => scriptingLanguages.has(languageId))
          .map(({ languageId }) => languageId)
          .sort(),
      ).toEqual([...scriptingLanguages].sort());
      expect(
        result.actions.filter(({ id }) =>
          [
            "rdbg",
            "vscode-php-debug",
            "local-lua-debugger",
            "vscode-bash-debug",
            "powershell-editor-services-debug",
          ].some((adapter) => id.includes(adapter)),
        ),
      ).toEqual([]);
      expect(
        result.sections
          .find(({ pluginId }) => pluginId === "debugger")
          ?.findings.filter(({ status }) => status !== "pass"),
      ).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

async function prepareFixtures(
  cwd: string,
  selected: string | undefined,
  excluded: string | undefined,
): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await Promise.all([mkdir(path.join(cwd, "src")), mkdir(path.join(cwd, "dist"))]);
  const python =
    "def total():\n    items = [12, 30]\n    subtotal = sum(items)\n    result = subtotal + 1\n    return result\nprint(total())\n";
  const javascript =
    "function total() {\n  const items = [12, 30];\n  const subtotal = items[0] + items[1];\n  const result = subtotal + 1;\n  return result;\n}\nconsole.log(total());\n";
  const typescript =
    "function total(): number {\n  const items: number[] = [12, 30];\n  const subtotal: number = items[0]! + items[1]!;\n  const result: number = subtotal + 1;\n  return result;\n}\nconsole.log(total());\n";
  const dart =
    "void main() {\n  final items = [12, 30];\n  final subtotal = items[0] + items[1];\n  final result = subtotal + 1;\n  print(result);\n}\n";
  const kotlin =
    "fun main() {\n    val items = listOf(12, 30)\n    val subtotal = items.sum()\n    val result = subtotal + 1\n    println(result)\n}\n";
  if (selected === "kotlin") {
    await mkdir(path.join(cwd, "src", "main", "kotlin"), { recursive: true });
    await writeFile(path.join(cwd, "src", "main", "kotlin", "Main.kt"), kotlin);
    await mkdir(path.join(cwd, "build", "classes", "kotlin", "main"), { recursive: true });
    await execute("kotlinc", ["src/main/kotlin/Main.kt", "-d", "build/classes/kotlin/main"], {
      cwd,
    });
    return;
  }
  const csharp =
    "using System;\ninternal static class Program\n{\n    private static void Main()\n    {\n        int subtotal = 12 + 30;\n        int result = subtotal + 1;\n        Console.WriteLine(result);\n    }\n}\n";
  const cpp =
    "#include <iostream>\nint main() {\n  int subtotal = 12 + 30;\n  int result = subtotal + 1;\n  std::cout << result << '\\n';\n}\n";
  const go =
    'package main\nimport "fmt"\nfunc main() {\n  items := []int{12, 30}\n  subtotal := items[0] + items[1]\n  result := subtotal + 1\n  fmt.Println(result)\n}\n';
  const rust =
    'fn main() {\n    let items = [12, 30];\n    let subtotal = items[0] + items[1];\n    let result = subtotal + 1;\n    println!("{result}");\n}\n';
  const ruby =
    "def total\n  items = [12, 30]\n  subtotal = items.sum\n  result = subtotal + 1\n  result\nend\nputs total\n";
  const php =
    "<?php\nfunction total() {\n    $items = [12, 30];\n    $subtotal = $items[0] + $items[1];\n    $result = $subtotal + 1;\n    return $result;\n}\necho total(), PHP_EOL;\n";
  const lua =
    "local function total()\n  local items = {12, 30}\n  local subtotal = items[1] + items[2]\n  local result = subtotal + 1\n  return result\nend\nprint(total())\n";
  const shell = `#!/usr/bin/env bash\nitems=(12 30)\nsubtotal=$((items[0] + items[1]))\nresult=$((subtotal + 1))\nprintf '%s\\n' "$result"\n`;
  const powershell =
    "$items = @(12, 30)\n$subtotal = $items[0] + $items[1]\n$result = $subtotal + 1\nWrite-Output $result\n";
  await Promise.all([
    writeFile(path.join(cwd, "main.dart"), dart),
    writeFile(path.join(cwd, "main.go"), go),
    writeFile(path.join(cwd, "main.py"), python),
    writeFile(path.join(cwd, "main.js"), javascript),
    writeFile(path.join(cwd, "main.ts"), typescript),
    writeFile(path.join(cwd, "src/main.ts"), typescript),
    writeFile(path.join(cwd, "main.cpp"), cpp),
    writeFile(path.join(cwd, "main.rs"), rust),
    ...(excluded === "kotlin"
      ? []
      : [
          mkdir(path.join(cwd, "src", "main", "kotlin"), { recursive: true }).then(() =>
            writeFile(path.join(cwd, "src", "main", "kotlin", "Main.kt"), kotlin),
          ),
        ]),
    mkdir(path.join(cwd, "csharp"), { recursive: true }).then(async () => {
      await Promise.all([
        writeFile(path.join(cwd, "csharp", "Program.cs"), csharp),
        writeFile(
          path.join(cwd, "csharp", "debug-matrix.csproj"),
          '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><DebugType>portable</DebugType></PropertyGroup></Project>\n',
        ),
      ]);
    }),
    writeFile(path.join(cwd, "main.rb"), ruby),
    writeFile(path.join(cwd, "main.php"), php),
    writeFile(path.join(cwd, "main.lua"), lua),
    writeFile(path.join(cwd, "main.sh"), shell, { mode: 0o755 }),
    writeFile(path.join(cwd, "main.ps1"), powershell),
  ]);
  await execute(
    "tsc",
    ["src/main.ts", "--target", "ES2022", "--module", "ESNext", "--sourceMap", "--outDir", "dist"],
    { cwd },
  );
  await execute("clang++", ["-g", "-O0", "main.cpp", "-o", "main-cpp"], { cwd });
  await execute("rustc", ["-g", "-C", "opt-level=0", "main.rs", "-o", "main-rust"], { cwd });
  if (excluded !== "kotlin") {
    await mkdir(path.join(cwd, "build", "classes", "kotlin", "main"), { recursive: true });
    await execute("kotlinc", ["src/main/kotlin/Main.kt", "-d", "build/classes/kotlin/main"], {
      cwd,
    });
  }
  await execute("dotnet", ["build", "--configuration", "Debug", "--nologo"], {
    cwd: path.join(cwd, "csharp"),
  });
}
