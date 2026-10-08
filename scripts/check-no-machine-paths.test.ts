import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

const root = findRepositoryRoot(import.meta.url);
const workspaces: string[] = [];

function workspace() {
  const container = path.join(root, ".tmp/path-check-tests");
  mkdirSync(container, { recursive: true });
  const cwd = mkdtempSync(path.join(container, "repo-"));
  workspaces.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  mkdirSync(path.join(cwd, ".pi/skills/new-project-skill"), { recursive: true });
  return cwd;
}

function check(cwd: string) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-no-machine-paths.ts")], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

test("accepts tracked and untracked files in any project skill directory", () => {
  const cwd = workspace();
  writeFileSync(path.join(cwd, ".pi/skills/new-project-skill/tracked.txt"), "Portable content\n");
  execFileSync("git", ["add", "."], { cwd });
  writeFileSync(
    path.join(cwd, ".pi/skills/new-project-skill/untracked.txt"),
    "More portable content\n",
  );
  const result = check(cwd);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Checked 2 repository files");
});

test.each([
  ["root home path", () => `/${["ro", "ot"].join("")}/private`],
  ["personal home path", () => `/home/${["to", "bi"].join("")}/private`],
  // oxlint-disable-next-line repo/no-parent-paths -- rejected fixture content, not a filesystem access
  ["local file dependency", () => `${["fi", "le"].join("")}:${["..", "private"].join("/")}`],
  ["current checkout path", (cwd: string) => cwd],
] as const)("still rejects %s inside project skills", (label, content) => {
  const cwd = workspace();
  writeFileSync(path.join(cwd, ".pi/skills/new-project-skill/payload.txt"), content(cwd));
  const result = check(cwd);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`.pi/skills/new-project-skill/payload.txt: ${label}`);
  expect(result.stderr).not.toContain("private repository path");
});
