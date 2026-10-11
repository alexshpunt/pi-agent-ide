import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const root = findRepositoryRoot(import.meta.url);
const workspaces: string[] = [];

function workspace() {
  const container = path.join(root, ".tmp/task-evidence-check-tests");
  mkdirSync(container, { recursive: true });
  const cwd = mkdtempSync(path.join(container, "repo-"));
  workspaces.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(path.join(cwd, ".gitignore"), "evidence/\nevidences/\n");
  writeFileSync(path.join(cwd, "package.json"), '{"type":"module"}\n');
  return cwd;
}

function check(cwd: string, staged = false) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-no-task-evidence.ts"), ...(staged ? ["--staged"] : [])],
    { cwd, encoding: "utf8" },
  );
}

function report(cwd: string, directory: string) {
  const file = `${directory}/LPT-report.md`;
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), "Private run results\n");
  execFileSync("git", ["add", "-f", "--", file], { cwd });
  return file;
}

afterEach(() => {
  for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

test.each(["evidence", "nested/evidences", ".tmp", ".agents"])(
  "rejects force-added run artifacts in %s without changing the index",
  (directory) => {
    const cwd = workspace();
    const file = report(cwd, directory);
    const before = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd });
    for (const staged of [true, false]) {
      const result = check(cwd, staged);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(file);
    }
    expect(execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd })).toEqual(before);
  },
);

test("accepts source named evidence.ts and ignores unstaged reports", () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "src/evidence.ts"), "export const value = true;\n");
  execFileSync("git", ["add", "src/evidence.ts"], { cwd });
  mkdirSync(path.join(cwd, "evidence"));
  writeFileSync(path.join(cwd, "evidence/untracked.md"), "Local results\n");
  expect(check(cwd, true).status).toBe(0);
  expect(check(cwd).status).toBe(0);
});

test("the installed pre-commit hook blocks reports and allows an ordinary commit", () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, "scripts"));
  mkdirSync(path.join(cwd, ".husky"));
  copyFileSync(
    path.join(root, "scripts/check-no-task-evidence.ts"),
    path.join(cwd, "scripts/check-no-task-evidence.ts"),
  );
  copyFileSync(path.join(root, ".husky/pre-commit"), path.join(cwd, ".husky/pre-commit"));
  chmodSync(path.join(cwd, ".husky/pre-commit"), 0o755);
  execFileSync(process.execPath, [path.join(root, "node_modules/husky/lib/bin.js"), "install"], {
    cwd,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd });
  const file = report(cwd, "evidence");
  const refused = spawnSync("git", ["commit", "-qm", "fixture"], { cwd, encoding: "utf8" });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain(file);
  expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd }).status).not.toBe(0);
  execFileSync("git", ["rm", "--cached", "--", file], { cwd });
  writeFileSync(path.join(cwd, "source.ts"), "export {};\n");
  execFileSync("git", ["add", "source.ts"], { cwd });
  const accepted = spawnSync("git", ["commit", "-qm", "fixture"], { cwd, encoding: "utf8" });
  expect(accepted.status).toBe(0);
});
