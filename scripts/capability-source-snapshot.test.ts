import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { snapshotSource } from "#capabilities/sandbox.ts";

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
