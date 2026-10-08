// Fixtures deliberately preserve parent-relative symlink text across relocation.
/* eslint-disable repo/no-parent-paths */
import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, expect, test, vi } from "vitest";
import { executeFileOperation } from "#src/core/file-operations.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-directory-transfer-"));
  roots.push(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await mkdir(path.join(cwd, "source", "nested", "empty"), { recursive: true });
  await writeFile(path.join(cwd, "source", "nested", "data"), Buffer.from([0, 255, 10]));
  await writeFile(path.join(cwd, "sentinel"), "untouched");
  await symlink("../../sentinel", path.join(cwd, "source", "nested", "link"));
  await symlink("missing", path.join(cwd, "source", "broken"));
  return cwd;
}
async function checkTree(cwd: string, name: string) {
  expect(await readFile(path.join(cwd, name, "nested", "data"))).toEqual(Buffer.from([0, 255, 10]));
  expect((await lstat(path.join(cwd, name, "nested", "empty"))).isDirectory()).toBe(true);
  expect(await readlink(path.join(cwd, name, "nested", "link"))).toBe("../../sentinel");
  expect(await readlink(path.join(cwd, name, "broken"))).toBe("missing");
  expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
}

for (const operation of ["copy", "move"] as const) {
  test(`${operation} transfers nested bytes, empty directories, and link objects to the exact target`, async () => {
    const cwd = await fixture();
    expect(
      await executeFileOperation(operation, { path: "source", target: "new/parents/target" }, cwd),
    ).toMatchObject({ ok: true, effect: "applied" });
    await checkTree(cwd, "new/parents/target");
    if (operation === "copy") await checkTree(cwd, "source");
    else await expect(lstat(path.join(cwd, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test(`${operation} merges or replaces an existing tree without following its links`, async () => {
    const cwd = await fixture();
    await mkdir(path.join(cwd, "target", "nested"), { recursive: true });
    await writeFile(path.join(cwd, "target", "nested", "data"), "old");
    await symlink("../sentinel", path.join(cwd, "target", "destination-only"));
    expect(
      await executeFileOperation(operation, { path: "source", target: "target" }, cwd),
    ).toMatchObject({ ok: true });
    await checkTree(cwd, "target");
    if (operation === "copy")
      expect(await readlink(path.join(cwd, "target", "destination-only"))).toBe("../sentinel");
    else
      await expect(lstat(path.join(cwd, "target", "destination-only"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  test(`${operation} transfers standalone normal and broken symlinks without dereferencing them`, async () => {
    const cwd = await fixture();
    for (const [name, referent] of [
      ["link", "sentinel"],
      ["broken", "missing"],
    ] as const) {
      await symlink(referent, path.join(cwd, name));
      expect(
        await executeFileOperation(operation, { path: name, target: `new/${name}` }, cwd),
      ).toMatchObject({ ok: true });
      expect(await readlink(path.join(cwd, "new", name))).toBe(referent);
      if (operation === "move")
        await expect(lstat(path.join(cwd, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
  });

  test(`${operation} refuses aliases, overlapping trees, and conflicting destination types before changes`, async () => {
    const cwd = await fixture();
    await symlink("source", path.join(cwd, "alias"));
    await symlink("source/nested", path.join(cwd, "parent-alias"));
    await mkdir(path.join(cwd, "container"));
    await symlink("../source", path.join(cwd, "container", "alias"));
    for (const [source, target] of [
      ["source", "source"],
      ["source", "source/new/deep"],
      ["source/nested", "source"],
      ["source", "parent-alias/new"],
      ["source", "alias"],
      ["container/alias/nested", "source"],
      ["source", "sentinel"],
      ["sentinel", "source"],
    ]) {
      expect(await executeFileOperation(operation, { path: source, target }, cwd)).toMatchObject({
        ok: false,
        effect: "not-applied",
      });
    }
    await link(path.join(cwd, "sentinel"), path.join(cwd, "hardlink"));
    expect(
      await executeFileOperation(operation, { path: "sentinel", target: "hardlink" }, cwd),
    ).toMatchObject({ ok: false, effect: "not-applied", error: { code: "SAME_FILE" } });
    await checkTree(cwd, "source");
    await expect(lstat(path.join(cwd, "source", "new"))).rejects.toMatchObject({ code: "ENOENT" });
  });
}

test("Copy refuses a nested destination link or type conflict before overwriting any files", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "target", "nested"), { recursive: true });
  await writeFile(path.join(cwd, "target", "nested", "data"), "old");
  await symlink("../../sentinel", path.join(cwd, "target", "nested", "empty"));
  expect(
    await executeFileOperation("copy", { path: "source", target: "target" }, cwd),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(await readFile(path.join(cwd, "target", "nested", "data"), "utf8")).toBe("old");
  expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
});

test("Move applies hooks and approval to both a tracked source and replacement directory", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "target"));
  await writeFile(path.join(cwd, "target", "old"), "keep");
  execFileSync("git", ["-C", cwd, "add", "source", "target"]);
  const input = { path: "source", target: "target" };
  expect(await executeFileOperation("move", input, cwd)).toMatchObject({
    error: { code: "DELETE_CONFIRMATION_REQUIRED" },
    effect: "not-applied",
  });
  const confirm = vi.fn(async (event: { path: string }) => event.path.endsWith("source"));
  expect(await executeFileOperation("move", input, cwd, undefined, { confirm })).toMatchObject({
    error: { code: "DELETE_NOT_APPROVED" },
    effect: "not-applied",
  });
  expect(confirm).toHaveBeenCalledTimes(2);
  await checkTree(cwd, "source");
  expect(await readFile(path.join(cwd, "target", "old"), "utf8")).toBe("keep");
  const beforeDelete = vi.fn(async (event: { path: string }) => {
    if (event.path.endsWith("target")) throw new Error("replacement denied");
  });
  expect(
    await executeFileOperation("move", input, cwd, undefined, {
      confirm: async () => true,
      beforeDelete,
    }),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(beforeDelete).toHaveBeenCalledTimes(2);
  expect(
    await executeFileOperation("move", input, cwd, undefined, { confirm: async () => true }),
  ).toMatchObject({ ok: true });
  await checkTree(cwd, "target");
});

test("Move rechecks the source after destination approval and stops on cancellation", async () => {
  for (const change of ["source", "target", "cancel"] as const) {
    const cwd = await fixture();
    await mkdir(path.join(cwd, "target"));
    await writeFile(path.join(cwd, "target", "old"), "keep");
    execFileSync("git", ["-C", cwd, "add", "source", "target"]);
    const controller = new AbortController();
    const result = await executeFileOperation(
      "move",
      { path: "source", target: "target" },
      cwd,
      controller.signal,
      {
        confirm: async (event) => {
          if (event.path.endsWith("target")) {
            if (change === "cancel") controller.abort();
            else {
              await rename(path.join(cwd, change), path.join(cwd, `${change}-original`));
              await mkdir(path.join(cwd, change));
            }
          }
          return true;
        },
      },
    );
    expect(result).toMatchObject({ ok: false, effect: "not-applied" });
    expect((await lstat(path.join(cwd, "source"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(cwd, "target"))).isDirectory()).toBe(true);
  }
});

test("directory transfers cannot overwrite project roots or Git control data", async () => {
  const cwd = await fixture();
  for (const operation of ["copy", "move"] as const) {
    for (const target of [cwd, path.dirname(cwd), ".git", ".git/new/deep"]) {
      expect(
        await executeFileOperation(operation, { path: "source", target }, cwd, undefined, {
          confirm: async () => true,
        }),
      ).toMatchObject({ ok: false, effect: "not-applied" });
    }
  }
  expect(
    await executeFileOperation("move", { path: cwd, target: `${cwd}-moved` }, cwd, undefined, {
      confirm: async () => true,
    }),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  await checkTree(cwd, "source");
});

test("reports unknown effects after a partial recursive copy without claiming rollback", async () => {
  const cwd = await fixture();
  const filesystem: { copy: (source: string, target: string) => Promise<void> } = fs;
  vi.spyOn(filesystem, "copy").mockImplementationOnce(async (_source, target) => {
    await mkdir(target);
    await writeFile(path.join(target, "partial"), "written");
    throw Object.assign(new Error("copy failed after first file"), { code: "EACCES" });
  });
  expect(
    await executeFileOperation("copy", { path: "source", target: "target" }, cwd),
  ).toMatchObject({ ok: false, effect: "unknown", error: { code: "EACCES" } });
  expect(await readFile(path.join(cwd, "target", "partial"), "utf8")).toBe("written");
  await checkTree(cwd, "source");
});

test.skipIf(process.platform !== "linux")(
  "Move crosses devices and keeps broken links and empty directories",
  async () => {
    const cwd = await fixture();
    const otherDevice = await mkdtemp(path.join("/dev/shm", "ide-directory-transfer-"));
    roots.push(otherDevice);
    expect((await lstat(cwd)).dev).not.toBe((await lstat(otherDevice)).dev);
    const target = path.join(otherDevice, "target");
    expect(await executeFileOperation("move", { path: "source", target }, cwd)).toMatchObject({
      ok: true,
      effect: "applied",
    });
    expect(await readFile(path.join(target, "nested", "data"))).toEqual(Buffer.from([0, 255, 10]));
    expect((await lstat(path.join(target, "nested", "empty"))).isDirectory()).toBe(true);
    expect(await readlink(path.join(target, "broken"))).toBe("missing");
    expect(await readlink(path.join(target, "nested", "link"))).toBe("../../sentinel");
    await expect(lstat(path.join(cwd, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    await symlink("missing", path.join(cwd, "standalone"));
    expect(
      await executeFileOperation(
        "move",
        { path: "standalone", target: path.join(otherDevice, "link") },
        cwd,
      ),
    ).toMatchObject({ ok: true });
    expect(await readlink(path.join(otherDevice, "link"))).toBe("missing");
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
  },
);

test("Move requires approval for external directories and staged standalone links", async () => {
  const cwd = await fixture();
  const external = await fixture();
  await symlink("missing", path.join(cwd, "staged-link"));
  execFileSync("git", ["-C", cwd, "add", "staged-link"]);
  for (const source of [path.join(external, "source"), "staged-link"]) {
    expect(
      await executeFileOperation("move", { path: source, target: "target" }, cwd),
    ).toMatchObject({
      ok: false,
      effect: "not-applied",
      error: { code: "DELETE_CONFIRMATION_REQUIRED" },
    });
    const beforeDelete = vi.fn(async () => {
      throw new Error("hook denied");
    });
    expect(
      await executeFileOperation("move", { path: source, target: "target" }, cwd, undefined, {
        beforeDelete,
        confirm: async () => true,
      }),
    ).toMatchObject({ ok: false, effect: "not-applied" });
    expect(beforeDelete).toHaveBeenCalledOnce();
  }
  await checkTree(external, "source");
  expect(await readlink(path.join(cwd, "staged-link"))).toBe("missing");
});

test("an in-flight Copy may complete after cancellation", async () => {
  const cwd = await fixture();
  const controller = new AbortController();
  const filesystem: { copy: (source: string, target: string) => Promise<void> } = fs;
  const copy = filesystem.copy;
  vi.spyOn(filesystem, "copy").mockImplementationOnce(async (source, target) => {
    controller.abort();
    await copy(source, target);
  });
  expect(
    await executeFileOperation(
      "copy",
      { path: "source", target: "target" },
      cwd,
      controller.signal,
    ),
  ).toMatchObject({ ok: true, effect: "applied" });
  await checkTree(cwd, "target");
});

test("Move reports unknown after destination replacement starts and fails", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "target"));
  await writeFile(path.join(cwd, "target", "old"), "old");
  const filesystem: { move: (source: string, target: string) => Promise<void> } = fs;
  vi.spyOn(filesystem, "move").mockImplementationOnce(async (_source, target) => {
    await rm(path.join(target, "old"));
    throw Object.assign(new Error("move failed after replacement began"), { code: "EACCES" });
  });
  expect(
    await executeFileOperation("move", { path: "source", target: "target" }, cwd),
  ).toMatchObject({ ok: false, effect: "unknown", error: { code: "EACCES" } });
  await expect(lstat(path.join(cwd, "target", "old"))).rejects.toMatchObject({ code: "ENOENT" });
  await checkTree(cwd, "source");
});
