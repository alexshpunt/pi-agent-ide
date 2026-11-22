import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitState } from "./sandbox.ts";

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

void test("Git fixture state ignores worktree changes but detects index and commit changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    await mkdir(path.join(root, "tracked"));
    await writeFile(path.join(root, "tracked", "data"), "KEEP\n");
    await writeFile(path.join(root, "other"), "KEEP\n");
    git("init", "--quiet");
    git("add", ".");
    git(...identity, "commit", "--quiet", "-m", "Initial");
    const initial = gitState(root);

    await rm(path.join(root, "tracked"), { recursive: true });
    await writeFile(path.join(root, "untracked"), "NEW\n");
    assert.equal(gitState(root), initial);

    git("rm", "--quiet", "--cached", "other");
    assert.notEqual(gitState(root), initial);
    git("add", "other");
    assert.equal(gitState(root), initial);

    git(...identity, "commit", "--quiet", "--allow-empty", "-m", "Extra");
    assert.notEqual(gitState(root), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
