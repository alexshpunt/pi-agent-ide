import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { executeFileOperation } from "#src/core/file-operations.js";

const exec = promisify(execFile);
let root: string;
let cwd: string;
let home: string;
let system: string;
let agent: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ide-temp-delete-"));
  cwd = path.join(root, "project");
  home = path.join(root, "home");
  system = path.join(root, "system");
  agent = path.join(root, "agent");
  await Promise.all([cwd, home, system, agent].map((directory) => mkdir(directory)));
  await exec("git", ["init", "-q", cwd]);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "tmpdir").mockReturnValue(system);
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function folder(directory: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "data"), "keep");
  return directory;
}
async function config(directory: string, mode: string, paths: unknown[]) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "deletion.json"),
    JSON.stringify({ temporaryDirectories: { mode, paths } }),
  );
}
const projectConfig = () => path.join(cwd, ".pi", "pi-agent-ide");
const globalConfig = () => path.join(agent, "pi-agent-ide");
const remove = (target: string, from = cwd, confirm = vi.fn(async () => false)) =>
  executeFileOperation("delete", { path: target }, from, undefined, { confirm });

test("cleans descendants of default project, home and system temp roots without approval", async () => {
  const confirm = vi.fn(async () => false);
  for (const base of [cwd, home]) {
    for (const name of ["tmp", ".tmp", "temp", ".temp"]) {
      const target = await folder(path.join(base, name, "scratch"));
      expect(await remove(target, cwd, confirm)).toMatchObject({ ok: true, effect: "applied" });
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }
  const target = await folder(path.join(system, "scratch"));
  expect(await remove(target, home, confirm)).toMatchObject({ ok: true });
  expect(confirm).not.toHaveBeenCalled();
});

test("keeps tracked approval even when the worktree is inside system temp", async () => {
  cwd = path.join(system, "worktree");
  await mkdir(cwd);
  await exec("git", ["init", "-q", cwd]);
  const target = await folder(path.join(cwd, "tmp", "tracked"));
  await symlink("tmp/tracked/data", path.join(cwd, "tmp", "tracked-link"));
  await exec("git", ["-C", cwd, "add", "."]);
  const confirm = vi.fn(async () => false);
  for (const entry of [target, path.join(cwd, "tmp", "tracked-link")])
    expect(await remove(entry, cwd, confirm)).toMatchObject({
      error: { code: "DELETE_NOT_APPROVED" },
    });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(await readFile(path.join(target, "data"), "utf8")).toBe("keep");
  expect(await remove(cwd)).toMatchObject({ error: { code: "DELETE_PROTECTED_TARGET" } });
  expect(await remove(path.join(cwd, ".git"))).toMatchObject({
    error: { code: "DELETE_PROTECTED_TARGET" },
  });
});

test("does not relax Git failures or deletion of the temp root itself", async () => {
  const target = await folder(path.join(cwd, "tmp", "scratch"));
  await writeFile(path.join(cwd, ".git", "index"), "bad index");
  expect(await remove(target)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
  expect(await remove(system)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
});

test("replaces defaults, extends lower layers and resolves relative and home paths", async () => {
  const custom = await folder(path.join(home, "global-scratch", "one"));
  const standard = await folder(path.join(system, "standard"));
  await config(globalConfig(), "replace", ["global-scratch"]);
  expect(await remove(standard)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
  expect(await remove(custom)).toMatchObject({ ok: true });
  await config(projectConfig(), "extend", ["project-scratch", "~/home-scratch"]);
  for (const target of [
    await folder(path.join(home, "global-scratch", "two")),
    await folder(path.join(cwd, "project-scratch", "one")),
    await folder(path.join(home, "home-scratch", "one")),
  ])
    expect(await remove(target)).toMatchObject({ ok: true });
  await config(projectConfig(), "replace", []);
  expect(await remove(await folder(path.join(home, "global-scratch", "three")))).toMatchObject({
    error: { code: "DELETE_NOT_APPROVED" },
  });
  expect(await remove(standard)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
});

test("extends defaults and excludes roots even when temporary roots overlap", async () => {
  const nested = path.join(system, "nested-root");
  await folder(path.join(nested, "scratch"));
  await config(globalConfig(), "extend", [nested]);
  expect(await remove(nested)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
  expect(await remove(path.join(nested, "scratch"))).toMatchObject({ ok: true });
  expect(await remove(await folder(path.join(system, "standard")))).toMatchObject({ ok: true });
});

test("does not trust a default named root redirected outside its base", async () => {
  const outside = await folder(path.join(root, "outside", "scratch"));
  await symlink(path.dirname(outside), path.join(home, "tmp"));
  expect(await remove(path.join(home, "tmp", "scratch"))).toMatchObject({
    error: { code: "DELETE_NOT_APPROVED" },
  });
});

test("regular-file deletion ignores directory exception settings", async () => {
  const target = await folder(path.join(system, "scratch"));
  await config(projectConfig(), "unknown", []);
  expect(await remove(path.join(target, "data"))).toMatchObject({ ok: true });
});
test("uses project settings at the worktree root when cwd is a subdirectory", async () => {
  await config(projectConfig(), "replace", []);
  const subdirectory = path.join(cwd, "src");
  await mkdir(subdirectory);
  expect(await remove(await folder(path.join(system, "scratch")), subdirectory)).toMatchObject({
    error: { code: "DELETE_NOT_APPROVED" },
  });
});

test("rejects name lookalikes and escaping parent links but unlinks the final link", async () => {
  const allowed = path.join(home, "scratch");
  await mkdir(allowed);
  await config(projectConfig(), "replace", [allowed]);
  const outside = await folder(path.join(home, "scratch-other", "tmp", "data"));
  await symlink(path.dirname(outside), path.join(allowed, "escape"));
  expect(await remove(outside)).toMatchObject({ error: { code: "DELETE_NOT_APPROVED" } });
  expect(await remove(path.join(allowed, "escape", "data"))).toMatchObject({
    error: { code: "DELETE_NOT_APPROVED" },
  });
  expect(await remove(path.join(allowed, "escape"))).toMatchObject({ ok: true });
  expect(await readFile(path.join(outside, "data"), "utf8")).toBe("keep");
});

test("keeps hooks and rechecks changed temp classification before removal", async () => {
  const target = await folder(path.join(system, "scratch"));
  const confirm = vi.fn(async () => false);
  const beforeDelete = vi.fn(async () => config(projectConfig(), "replace", []));
  expect(
    await executeFileOperation("delete", { path: target }, cwd, undefined, {
      beforeDelete,
      confirm,
    }),
  ).toMatchObject({ error: { code: "DELETE_TARGET_CHANGED" } });
  expect(beforeDelete).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(path.join(target, "data"), "utf8")).toBe("keep");
});

test("keeps Move approval for an external temp directory", async () => {
  const target = await folder(path.join(system, "scratch"));
  expect(
    await executeFileOperation("move", { path: target, target: path.join(system, "moved") }, cwd),
  ).toMatchObject({ error: { code: "DELETE_CONFIRMATION_REQUIRED" } });
  expect(await readFile(path.join(target, "data"), "utf8")).toBe("keep");
});

test("invalid settings fail closed before deletion", async () => {
  const target = await folder(path.join(system, "scratch"));
  for (const [mode, paths] of [
    ["unknown", []],
    ["replace", [""]],
    ["extend", [12]],
  ] as const) {
    await config(projectConfig(), mode, [...paths]);
    expect(await remove(target)).toMatchObject({ ok: false, effect: "not-applied" });
    expect(await readFile(path.join(target, "data"), "utf8")).toBe("keep");
  }
});
