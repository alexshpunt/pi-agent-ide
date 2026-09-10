import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeFileOperation } from "#src/core/file-operations.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ide-file-operations-"));
  roots.push(root);
  await writeFile(path.join(root, "source"), Buffer.from([0, 255, 10]));
  return root;
}

test("copies bytes, moves the copy, and removes only the moved file", async () => {
  const cwd = await fixture();
  expect(
    (await executeFileOperation("copy_file", { path: "source", target: "copy" }, cwd)).ok,
  ).toBe(true);
  expect(await readFile(path.join(cwd, "copy"))).toEqual(Buffer.from([0, 255, 10]));
  expect((await executeFileOperation("move_file", { path: "copy", target: "moved" }, cwd)).ok).toBe(
    true,
  );
  await expect(lstat(path.join(cwd, "copy"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await executeFileOperation("delete_file", { path: "moved" }, cwd)).ok).toBe(true);
  await expect(lstat(path.join(cwd, "moved"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});

for (const operation of ["copy_file", "move_file"] as const) {
  test(`${operation} refuses an existing target unless overwrite is explicit`, async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "target"), "keep");
    const rejected = await executeFileOperation(
      operation,
      { path: "source", target: "target" },
      cwd,
    );
    expect(rejected).toMatchObject({ ok: false, effect: "not-applied" });
    expect(await readFile(path.join(cwd, "target"), "utf8")).toBe("keep");
    expect(
      (
        await executeFileOperation(
          operation,
          { path: "source", target: "target", overwrite: true },
          cwd,
        )
      ).ok,
    ).toBe(true);
    expect(await readFile(path.join(cwd, "target"))).toEqual(Buffer.from([0, 255, 10]));
  });
}

test("refuses directories and symbolic links without touching their contents", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "dir"));
  await symlink(path.join(cwd, "source"), path.join(cwd, "link"));
  for (const name of ["dir", "link"]) {
    for (const operation of ["copy_file", "move_file", "delete_file"] as const) {
      expect(
        await executeFileOperation(
          operation,
          { path: name, ...(operation === "delete_file" ? {} : { target: "new" }) },
          cwd,
        ),
      ).toMatchObject({ ok: false, effect: "not-applied" });
    }
  }
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});

test("refuses symlink targets, identical paths, and cancelled operations", async () => {
  const cwd = await fixture();
  await symlink(path.join(cwd, "source"), path.join(cwd, "target-link"));
  for (const operation of ["copy_file", "move_file"] as const) {
    expect(
      await executeFileOperation(
        operation,
        { path: "source", target: "target-link", overwrite: true },
        cwd,
      ),
    ).toMatchObject({ ok: false, effect: "not-applied" });
    expect(
      await executeFileOperation(
        operation,
        { path: "source", target: "source", overwrite: true },
        cwd,
      ),
    ).toMatchObject({ ok: false, effect: "not-applied" });
  }
  const controller = new AbortController();
  controller.abort();
  expect(
    await executeFileOperation("delete_file", { path: "source" }, cwd, controller.signal),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});
