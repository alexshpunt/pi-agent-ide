import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";

import { readSshTargets, resolveSshConfigPaths } from "./config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = path.resolve(".tmp", "ssh-config-tests", randomUUID());
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return {
    globalPath: path.join(directory, "global.json"),
    projectPath: path.join(directory, "project.json"),
  };
}

test("SSH settings sit next to global and project extension settings", () => {
  expect(
    resolveSshConfigPaths({
      globalPath: "/home/me/.pi/agent/pi-agent-ide/extensions.json",
      projectPath: "/project/.pi/pi-agent-ide/extensions.json",
    }),
  ).toEqual({
    globalPath: "/home/me/.pi/agent/pi-agent-ide/ssh.json",
    projectPath: "/project/.pi/pi-agent-ide/ssh.json",
  });
});

test("absent SSH settings enable no targets", async () => {
  expect(await readSshTargets(await fixture())).toEqual([]);
});

test("project target replaces the complete global record without losing other targets", async () => {
  const paths = await fixture();
  await writeFile(
    paths.globalPath,
    JSON.stringify({
      targets: [
        { id: "dev", host: "global", workspace: "/global", configFile: "global-config" },
        { id: "other", host: "other", workspace: "/other" },
      ],
    }),
  );
  await writeFile(
    paths.projectPath,
    JSON.stringify({ targets: [{ id: "dev", host: "project", workspace: "/project" }] }),
  );
  expect(await readSshTargets(paths)).toEqual([
    { id: "dev", host: "project", workspace: "/project" },
    { id: "other", host: "other", workspace: "/other" },
  ]);
});

test("SSH settings reject duplicates and malformed targets instead of falling back", async () => {
  const paths = await fixture();
  const target = { id: "dev", host: "safe", workspace: "/workspace" };
  for (const targets of [
    [target, target],
    [{ ...target, host: "safe; touch wrong" }],
    [{ ...target, workspace: "relative" }],
    [{ ...target, password: "secret-value" }],
  ]) {
    await writeFile(paths.projectPath, JSON.stringify({ targets }));
    await expect(readSshTargets(paths)).rejects.toThrow("Invalid SSH settings");
    try {
      await readSshTargets(paths);
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  }
});
