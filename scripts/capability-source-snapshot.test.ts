import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { cleanupTrial, prepareTrial, snapshotSource } from "#capabilities/sandbox.ts";

test("source snapshots omit project package caches and do not hash their contents", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/capability-source-cache-"));
  try {
    await mkdir(path.join(root, "first"));
    await mkdir(path.join(root, "second"));
    const repository = path.join(root, "repository");
    await mkdir(repository);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository });
    git("init", "--quiet");
    await writeFile(path.join(repository, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(repository, "input.txt"), "SOURCE_FIXTURE\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create source fixture",
    );
    const cache = path.join(repository, ".pi/npm");
    await mkdir(path.join(cache, "node_modules/cache-fixture"), { recursive: true });
    await writeFile(path.join(cache, "package.json"), '{"name":"unrelated-project-cache"}\n');
    await writeFile(path.join(cache, "node_modules/cache-fixture/index.js"), "CACHE_ONLY\n");
    const first = await snapshotSource(repository, path.join(root, "first"));
    await expect(access(path.join(first.source, ".pi/npm"))).rejects.toThrow("ENOENT");
    expect(await readFile(path.join(first.source, "input.txt"), "utf8")).toBe("SOURCE_FIXTURE\n");
    await writeFile(path.join(cache, "package.json"), '{"name":"changed-project-cache"}\n');
    const second = await snapshotSource(repository, path.join(root, "second"));
    expect(second.digest).toBe(first.digest);
    await expect(access(path.join(second.source, ".pi/npm"))).rejects.toThrow("ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen sources do not repack objects while concurrent trials clone them", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/capability-source-maintenance-"));
  const marker = path.join(root, "auto-gc");
  const repository = path.join(root, "repository");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    await mkdir(repository);
    const hooks = path.join(root, "hooks");
    await mkdir(hooks);
    const hook = path.join(hooks, "pre-auto-gc");
    await writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "$PWD" >> "${marker}"\n`);
    await chmod(hook, 0o755);
    const config = path.join(root, "gitconfig");
    await writeFile(
      config,
      `[gc]\n  auto = 1\n  autoPackLimit = 1\n  autoDetach = false\n[maintenance]\n  auto = true\n[core]\n  hooksPath = ${hooks}\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    git(repository, "init", "--quiet");
    git(repository, "config", "gc.auto", "0");
    git(repository, "config", "maintenance.auto", "false");
    git(repository, "config", "user.name", "Fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    // Three independent packs exceed the inherited auto-GC threshold.
    for (let index = 0; index < 3; index++) {
      await writeFile(path.join(repository, `input-${index}.txt`), `SOURCE_${index}\n`);
      git(repository, "add", ".");
      git(repository, "commit", "--quiet", "-m", `Fixture ${index}`);
      git(repository, "repack", "-d");
    }
    const packs = (await readdir(path.join(repository, ".git/objects/pack")))
      .filter((file) => file.endsWith(".pack"))
      .sort();
    expect(packs).toHaveLength(3);
    // Positive control: these exact objects and settings really trigger Git maintenance.
    const control = path.join(root, "control");
    git(root, "clone", "--quiet", "--no-hardlinks", repository, control);
    git(control, "gc", "--auto");
    expect(await readFile(marker, "utf8")).toContain(control);
    await rm(marker);
    const frozen = await snapshotSource(repository, root);
    await expect(access(marker)).rejects.toThrow("ENOENT");
    const frozenHead = git(frozen.source, "rev-parse", "HEAD");
    const objectFiles = () =>
      readdir(path.join(frozen.source, ".git/objects"), { recursive: true });
    const before = (await objectFiles()).sort();
    for (let wave = 0; wave < 3; wave++) {
      const trials = await Promise.allSettled(
        Array.from({ length: 20 }, async () => {
          const trial = await prepareTrial(root, frozen.source, {
            id: "clone-stress",
            capabilities: [],
            modes: [],
            steps: [],
            files: { "fixture.txt": "TRIAL_CONTENT\n" },
          });
          try {
            const workspace = path.dirname(trial.cwd);
            expect(git(workspace, "rev-parse", "HEAD")).toBe(frozenHead);
            expect(git(workspace, "show", "HEAD:input-2.txt")).toBe("SOURCE_2");
            git(workspace, "fsck", "--no-dangling");
            expect(await readFile(path.join(trial.cwd, "fixture.txt"), "utf8")).toBe(
              "TRIAL_CONTENT\n",
            );
          } finally {
            await cleanupTrial(root, trial.root);
          }
        }),
      );
      expect(trials.filter((trial) => trial.status === "rejected")).toEqual([]);
    }
    expect((await objectFiles()).sort()).toEqual(before);
    await expect(access(marker)).rejects.toThrow("ENOENT");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
