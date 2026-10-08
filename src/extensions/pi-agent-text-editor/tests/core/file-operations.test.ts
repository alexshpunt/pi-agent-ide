import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeFileOperation } from "#src/core/file-operations.js";
import { isWholeFileInvocation } from "#src/core/file-operation-tools.js";

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

test("whole-file mode requires paths and no text selectors", () => {
  expect(isWholeFileInvocation("copy", { path: "a", target: "b" })).toBe(true);
  expect(isWholeFileInvocation("move", { path: "a", target: "b" })).toBe(true);
  expect(isWholeFileInvocation("delete", { path: "a" })).toBe(true);
  expect(isWholeFileInvocation("copy", { path: "a", target: "b", start: "alpha" })).toBe(false);
  expect(isWholeFileInvocation("delete", { path: "a", start: "alpha" })).toBe(false);
  expect(isWholeFileInvocation("delete", { path: "SEARCH#ABCD:all:line" })).toBe(false);
  expect(isWholeFileInvocation("delete", {})).toBe(false);
});

test("direct symbol deletion never enters whole-file mode", () => {
  for (const source of ["symbol:source.ts#greet", "symbol:source.ts", "symbol:source.ts#missing"]) {
    expect(isWholeFileInvocation("delete", { path: source })).toBe(false);
  }
});

test("copies bytes, moves the copy, and removes only the moved file", async () => {
  const cwd = await fixture();
  expect((await executeFileOperation("copy", { path: "source", target: "copy" }, cwd)).ok).toBe(
    true,
  );
  expect(await readFile(path.join(cwd, "copy"))).toEqual(Buffer.from([0, 255, 10]));
  expect((await executeFileOperation("move", { path: "copy", target: "moved" }, cwd)).ok).toBe(
    true,
  );
  await expect(lstat(path.join(cwd, "copy"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await executeFileOperation("delete", { path: "moved" }, cwd)).ok).toBe(true);
  await expect(lstat(path.join(cwd, "moved"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});

for (const operation of ["copy", "move"] as const) {
  test(`${operation} replaces an existing target without a separate flag`, async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "target"), "old target");
    const result = await executeFileOperation(operation, { path: "source", target: "target" }, cwd);
    expect(result).toMatchObject({ ok: true, effect: "applied" });
    expect(await readFile(path.join(cwd, "target"))).toEqual(Buffer.from([0, 255, 10]));
    if (operation === "move")
      await expect(lstat(path.join(cwd, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
  });
}

test("refuses directories and symbolic links without touching their contents", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "dir"));
  await symlink(path.join(cwd, "source"), path.join(cwd, "link"));
  for (const name of ["dir", "link"]) {
    for (const operation of ["copy", "move", "delete"] as const) {
      expect(
        await executeFileOperation(
          operation,
          { path: name, ...(operation === "delete" ? {} : { target: "new" }) },
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
  for (const operation of ["copy", "move"] as const) {
    expect(
      await executeFileOperation(operation, { path: "source", target: "target-link" }, cwd),
    ).toMatchObject({ ok: false, effect: "not-applied" });
    expect(
      await executeFileOperation(operation, { path: "source", target: "source" }, cwd),
    ).toMatchObject({ ok: false, effect: "not-applied" });
  }
  const controller = new AbortController();
  controller.abort();
  expect(
    await executeFileOperation("delete", { path: "source" }, cwd, controller.signal),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});
