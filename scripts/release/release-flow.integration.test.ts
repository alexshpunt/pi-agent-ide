import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { synchronizeDevelop } from "./sync-develop.ts";

const policy = path.resolve("scripts/release/merge-policy.ts");
const syncScript = path.resolve("scripts/release/sync-develop.ts");

test("release freeze, fix rebase, develop synchronization and unfreeze", () => {
  const root = path.resolve(".agents/tmp/release-flow-scenario");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "case-"));
  const bare = path.join(directory, "remote.git");
  const work = path.join(directory, "work");
  mkdirSync(work);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (file: string, body: string) => {
    writeFileSync(path.join(work, file), body);
    git("add", file);
    git("commit", "-m", `Update ${file}`);
  };
  const check = (head: string, labels: string[] = []) =>
    execFileSync(process.execPath, ["--experimental-strip-types", policy], {
      cwd: work,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "alexshpunt/pi-agent-ide",
        PR_HEAD: head,
        PR_LABELS: JSON.stringify(labels),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    execFileSync("git", ["init", "--bare", bare]);
    git("init", "-b", "main");
    git("config", "user.name", "Release test");
    git("config", "user.email", "release@example.invalid");
    git("remote", "add", "origin", bare);
    commit("app.txt", "initial\n");
    git("push", "-u", "origin", "main");
    git("switch", "-c", "develop");
    commit("feature.txt", "ready\n");
    git("push", "-u", "origin", "develop");
    git("switch", "main");
    git("merge", "--no-ff", "develop", "-m", "Integrate feature");
    git("push", "origin", "main");
    git("switch", "-c", "release/0.7.0");
    commit("version.txt", "0.7.0\n");
    git("push", "-u", "origin", "release/0.7.0");

    expect(() => check("develop")).toThrow(Error);
    expect(() => check("feature/new", ["release-fix"])).toThrow(Error);
    expect(() => check("fix/release-crash", ["release-fix"])).not.toThrow();
    expect(() => check("release/0.7.0")).not.toThrow();

    git("switch", "main");
    commit("fix.txt", "fix\n");
    git("push", "origin", "main");
    git("switch", "release/0.7.0");
    git("rebase", "main");
    git("push", "--force-with-lease", "origin", "release/0.7.0");
    git("switch", "main");
    git("merge", "--squash", "release/0.7.0");
    git("commit", "-m", "Publish candidate");
    git("push", "origin", "main");
    const beforeSync = git("ls-remote", "origin", "refs/heads/develop").split("\t")[0];
    execFileSync(process.execPath, ["--experimental-strip-types", syncScript], {
      cwd: work,
      env: { ...process.env, SKIP_ACTIVE_RELEASE: "true" },
    });
    expect(git("ls-remote", "origin", "refs/heads/develop").split("\t")[0]).toBe(beforeSync);
    synchronizeDevelop(work);
    const synced = git("ls-remote", "origin", "refs/heads/develop").split("\t")[0];
    expect(synced).toBe(git("rev-parse", "origin/develop"));
    expect(git("merge-base", "--is-ancestor", "main", "origin/develop")).toBe("");
    synchronizeDevelop(work);
    expect(git("ls-remote", "origin", "refs/heads/develop").split("\t")[0]).toBe(synced);
    expect(() => check("develop")).toThrow(Error);
    const head = git("rev-parse", "release/0.7.0");
    git(
      "push",
      `--force-with-lease=refs/heads/release/0.7.0:${head}`,
      "origin",
      ":refs/heads/release/0.7.0",
    );
    expect(() => check("develop")).not.toThrow();
    git("switch", "main");
    commit("next.txt", "after release\n");
    git("push", "origin", "main");
    execFileSync(process.execPath, ["--experimental-strip-types", syncScript], {
      cwd: work,
      env: { ...process.env, SKIP_ACTIVE_RELEASE: "true" },
    });
    expect(git("merge-base", "--is-ancestor", "main", "origin/develop")).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
