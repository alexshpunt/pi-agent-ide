import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDebuggerSetup } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("Doctor classifies a missing debugger runtime", async () => {
  const result = await inspectDebuggerSetup(context("python", { PATH: "/missing" }));
  expect(result.actions?.map(({ category }) => category)).toContain("missing-runtime");
});

test("Doctor distinguishes a missing adapter from an available runtime", async () => {
  const bin = await fakeExecutable("go", "exit 0", "@exit /b 0");
  const result = await inspectDebuggerSetup(context("go", { PATH: bin }));
  expect(result.actions?.map(({ category }) => category)).toContain("missing-adapter");
});

test.skipIf(process.platform === "win32")(
  "Doctor distinguishes adapter startup failure",
  async () => {
    const bin = await fakeExecutable(
      "python3",
      'case "$*" in *find_spec*) exit 0;; *) exit 1;; esac',
      '@echo off\necho %* | findstr /C:"find_spec" >nul\nif %errorlevel%==0 exit /b 0\nexit /b 1',
    );
    const result = await inspectDebuggerSetup(context("python", { PATH: bin }), "linux");
    expect(result.actions?.map(({ category }) => category)).toContain("adapter-startup");
  },
);

test("Doctor uses the configured Python executable on Windows", async () => {
  const bin = await fakeExecutable("python", "exit 0", "@exit /b 0");
  const result = await inspectDebuggerSetup(
    context("python", {
      PATH: bin,
      PI_PYTHON_PATH: path.join(bin, process.platform === "win32" ? "python.cmd" : "python"),
    }),
    "win32",
  );
  expect(result.actions).toEqual([]);
});

test("Doctor falls back to python3 when python is unavailable on Windows", async () => {
  const bin = await fakeExecutable("python3", "exit 0", "@exit /b 0");
  const result = await inspectDebuggerSetup(context("python", { PATH: bin }), "win32");
  expect(result.actions).toEqual([]);
});

const adapterCases: {
  language: string;
  runtimes: [string, ...string[]];
  adapter?: string;
  variable: string;
}[] = [
  {
    language: "csharp",
    runtimes: ["dotnet"],
    adapter: "netcoredbg",
    variable: "PI_NETCOREDBG_PATH",
  },
  { language: "ruby", runtimes: ["ruby"], adapter: "rdbg", variable: "PI_RUBY_DEBUG_PATH" },
  { language: "php", runtimes: ["php", "node"], variable: "PI_PHP_DEBUG_PATH" },
  { language: "lua", runtimes: ["lua", "node"], variable: "PI_LUA_DEBUG_PATH" },
  { language: "shell", runtimes: ["bash", "node"], variable: "PI_BASH_DEBUG_PATH" },
  { language: "powershell", runtimes: ["pwsh"], variable: "PI_POWERSHELL_EDITOR_SERVICES_PATH" },
];

test.skipIf(process.platform === "win32").each(adapterCases)(
  "Doctor checks the $language adapter without Python",
  async ({ language, runtimes, adapter, variable }) => {
    const bin = await fakeExecutable(runtimes[0], "exit 0");
    for (const runtime of runtimes.slice(1)) {
      const executable = path.join(bin, runtime);
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
    }
    const adapterPath = path.join(bin, "configured-adapter");
    const env = { PATH: bin, [variable]: adapterPath };
    expect(
      (await inspectDebuggerSetup(context(language, env))).actions?.map(({ category }) => category),
    ).toEqual(["missing-adapter"]);

    const python = path.join(bin, "python3");
    await writeFile(python, "#!/bin/sh\nexit 0\n");
    await chmod(python, 0o755);
    expect(
      (await inspectDebuggerSetup(context(language, env))).actions?.map(({ category }) => category),
    ).toEqual(["missing-adapter"]);
    await rm(python);
    if (language === "powershell") {
      await mkdir(path.join(adapterPath, "PowerShellEditorServices"), { recursive: true });
      await writeFile(
        path.join(adapterPath, "PowerShellEditorServices/Start-EditorServices.ps1"),
        "",
      );
    } else {
      await writeFile(adapterPath, adapter ? "#!/bin/sh\nexit 0\n" : "");
      if (adapter) await chmod(adapterPath, 0o755);
    }
    expect((await inspectDebuggerSetup(context(language, env))).actions).toEqual([]);

    const failingExecutable = adapter ? adapterPath : path.join(bin, runtimes[0]);
    await writeFile(failingExecutable, "#!/bin/sh\nexit 1\n");
    expect(
      (await inspectDebuggerSetup(context(language, env))).actions?.map(({ category }) => category),
    ).toEqual(["adapter-startup"]);
  },
);
function context(language: string, env: NodeJS.ProcessEnv) {
  return {
    cwd: process.cwd(),
    files: [],
    detectedLanguageIds: new Set([language]),
    detectedLanguages: new Map([[language, []]]),
    env,
  };
}

async function fakeExecutable(
  name: string,
  body: string,
  windowsBody = "@exit /b 0",
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-debug-doctor-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, name);
  await writeFile(executable, `#!/bin/sh\n${body}\n`);
  await chmod(executable, 0o755);
  await writeFile(`${executable}.cmd`, `${windowsBody}\r\n`);
  return directory;
}
