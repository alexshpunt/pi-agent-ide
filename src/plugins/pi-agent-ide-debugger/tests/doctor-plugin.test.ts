import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
