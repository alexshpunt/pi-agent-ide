import { execFile } from "node:child_process";
import * as filesystem from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { executeFileOperation } from "#src/core/file-operations.js";

test("reports unknown effects when recursive removal fails after removing an entry", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "folder", "remaining"), "still here");
  const result = await executeFileOperation("delete", { path: "folder" }, cwd, undefined, {
    removeDirectory: async (directory) => {
      await filesystem.unlink(path.join(directory, "data"));
      throw Object.assign(new Error("fixture removal failed after first entry"), {
        code: "EACCES",
      });
    },
  });
  expect(result).toMatchObject({
    ok: false,
    effect: "unknown",
    error: { code: "EACCES" },
  });
  await expect(lstat(path.join(cwd, "folder", "data"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(cwd, "folder", "remaining"), "utf8")).toBe("still here");
});

test("checks tracked siblings against the root when Pi starts in a subdirectory", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "subdirectory"));
  await exec("git", ["-C", cwd, "add", "folder/data"]);
  expect(await remove(path.join(cwd, "subdirectory"), path.join(cwd, "folder"))).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  await symlink("folder/data", path.join(cwd, "tracked-link"));
  await exec("git", ["-C", cwd, "add", "tracked-link"]);
  expect(await remove(cwd, "tracked-link")).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  expect(await remove(cwd, "tracked-link", async () => true)).toMatchObject({ ok: true });
  expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
});

test("rejects an ancestor symlink redirected while confirmation is open", async () => {
  const cwd = await fixture();
  const first = await fixture(false);
  const second = await fixture(false);
  await symlink(first, path.join(cwd, "alias"));
  expect(
    await remove(cwd, "alias/folder", async () => {
      await filesystem.unlink(path.join(cwd, "alias"));
      await symlink(second, path.join(cwd, "alias"));
      return true;
    }),
  ).toMatchObject({ error: { code: "DELETE_TARGET_CHANGED" } });
  for (const root of [first, second])
    expect(await readFile(path.join(root, "folder", "data"), "utf8")).toBe("keep");
});

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(git = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ide-delete-policy-"));
  roots.push(root);
  if (git) await exec("git", ["init", "-q", root]);
  // These cases exercise the original policy with the temporary exception disabled.
  await mkdir(path.join(root, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(root, ".pi", "pi-agent-ide", "deletion.json"),
    JSON.stringify({ temporaryDirectories: { mode: "replace", paths: [] } }),
  );
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder", "data"), "keep");
  return root;
}
const remove = (cwd: string, target: string, confirm?: () => Promise<boolean>) =>
  executeFileOperation("delete", { path: target }, cwd, undefined, { confirm });

test("removes an untracked directory and never follows links inside it", async () => {
  const cwd = await fixture();
  const external = await fixture(false);
  await symlink(path.join(external, "folder"), path.join(cwd, "folder", "outside"));
  const confirm = vi.fn(async () => false);
  expect(await remove(cwd, "folder", confirm)).toMatchObject({ ok: true, effect: "applied" });
  expect(confirm).not.toHaveBeenCalled();
  await expect(lstat(path.join(cwd, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(external, "folder", "data"), "utf8")).toBe("keep");
});

test("requires approval for staged and committed directory contents", async () => {
  const cwd = await fixture();
  await exec("git", ["-C", cwd, "add", "folder/data"]);
  for (const committed of [false, true]) {
    if (committed)
      await exec("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture",
      ]);
    const denied = vi.fn(async () => false);
    expect(await remove(cwd, "folder", denied)).toMatchObject({ ok: false, effect: "not-applied" });
    expect(denied).toHaveBeenCalledOnce();
    expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
  }
  expect(await remove(cwd, "folder", async () => true)).toMatchObject({ ok: true });
});

test("asks for external, non-Git and failed-Git targets and refuses without a dialog", async () => {
  const cwd = await fixture();
  const outside = await fixture(false);
  const confirm = vi.fn(async () => true);
  expect(await remove(cwd, path.join(outside, "folder"))).toMatchObject({
    ok: false,
    effect: "not-applied",
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  expect(await remove(cwd, path.join(outside, "folder"), confirm)).toMatchObject({ ok: true });
  expect(await remove(outside, "folder")).not.toMatchObject({ ok: true });
  await mkdir(path.join(outside, "other"));
  expect(await remove(outside, "other")).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  await writeFile(path.join(cwd, ".git", "index"), "invalid index");
  expect(await remove(cwd, "folder")).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  expect(confirm).toHaveBeenCalledOnce();
});

test("unlinks normal and broken symlinks without touching their targets", async () => {
  const cwd = await fixture();
  for (const [name, target] of [
    ["link", "folder"],
    ["broken", "missing"],
  ] as const) {
    await symlink(target, path.join(cwd, name));
    expect(await remove(cwd, name)).toMatchObject({ ok: true });
    await expect(lstat(path.join(cwd, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
});

test("resolves parent links for the boundary but not the final symlink", async () => {
  const cwd = await fixture();
  const outside = await fixture(false);
  await symlink(outside, path.join(cwd, "parent"));
  expect(await remove(cwd, "parent/folder")).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
  });
  expect(await remove(cwd, "parent")).toMatchObject({ ok: true });
  expect(await readFile(path.join(outside, "folder", "data"), "utf8")).toBe("keep");
});

test("blocks roots, ancestors and Git data of every type even with approval", async () => {
  const cwd = await fixture();
  const confirm = vi.fn(async () => true);
  for (const target of [cwd, path.dirname(cwd), path.parse(cwd).root, ".git", ".git/config"]) {
    expect(await remove(cwd, target, confirm)).toMatchObject({
      ok: false,
      effect: "not-applied",
      error: { code: "DELETE_PROTECTED_TARGET" },
    });
  }
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
  const worktree = path.join(cwd, "linked");
  await exec("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  await exec("git", ["-C", cwd, "worktree", "add", "-qb", "fixture", worktree]);
  expect(await remove(worktree, ".git", confirm)).toMatchObject({
    error: { code: "DELETE_PROTECTED_TARGET" },
  });
  expect(await remove(worktree, path.join(cwd, ".git", "config"), confirm)).toMatchObject({
    error: { code: "DELETE_PROTECTED_TARGET" },
  });
});

test("protects cwd and ancestors without Git", async () => {
  const cwd = await fixture(false);
  expect(await remove(cwd, cwd, async () => true)).toMatchObject({
    error: { code: "DELETE_PROTECTED_TARGET" },
  });
});

test("refuses replacement objects and changed Git classification after approval", async () => {
  for (const change of ["replace", "stage", "parent"] as const) {
    const cwd = await fixture();
    await exec("git", ["-C", cwd, "add", "folder/data"]);
    const confirm = async () => {
      if (change === "replace") {
        await rename(path.join(cwd, "folder"), path.join(cwd, "original"));
        await mkdir(path.join(cwd, "folder"));
        await writeFile(path.join(cwd, "folder", "data"), "replacement");
      } else if (change === "stage") {
        await exec("git", ["-C", cwd, "rm", "--cached", "-qr", "folder"]);
      } else {
        await rename(path.join(cwd, "folder"), path.join(cwd, "original"));
        await symlink("original", path.join(cwd, "folder"));
      }
      return true;
    };
    expect(await remove(cwd, "folder", confirm)).toMatchObject({
      ok: false,
      effect: "not-applied",
      error: { code: "DELETE_TARGET_CHANGED" },
    });
    expect(await lstat(path.join(cwd, "folder"))).toBeDefined();
  }
});

test("cancellation while approval is open prevents removal", async () => {
  const cwd = await fixture(false);
  const controller = new AbortController();
  expect(
    await executeFileOperation("delete", { path: "folder" }, cwd, controller.signal, {
      confirm: async () => {
        controller.abort();
        return true;
      },
    }),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(await readFile(path.join(cwd, "folder", "data"), "utf8")).toBe("keep");
});
