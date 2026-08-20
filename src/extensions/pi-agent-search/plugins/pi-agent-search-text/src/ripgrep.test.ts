import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { resolveRipgrepExecutable } from "#src/ripgrep.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test.each([
  ["linux", "rg"],
  ["win32", "rg.exe"],
] as const)("resolves Pi's bundled ripgrep binary on %s", async (platform, executableName) => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-ripgrep-"));
  temporaryDirectories.push(agentDirectory);
  const executable = path.join(agentDirectory, "bin", executableName);
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture", "utf8");

  expect(resolveRipgrepExecutable(agentDirectory, platform)).toBe(executable);
});

test("falls back to the system PATH when Pi has no bundled binary", async () => {
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-agent-ripgrep-"));
  temporaryDirectories.push(agentDirectory);

  expect(resolveRipgrepExecutable(agentDirectory, "win32")).toBe("rg");
});
