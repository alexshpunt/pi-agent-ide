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

test("whole-file owners receive original SSH identities before local path resolution", async () => {
  const calls: unknown[] = [];
  const resolver = async (operation: string, input: unknown, context: unknown) => {
    calls.push({ operation, input, context });
    return {
      kind: "file-operation" as const,
      operation: "copy" as const,
      ok: true,
      effect: "applied" as const,
      path: "ssh://sandbox/tmp/source.bin",
      target: "ssh://sandbox/tmp/destination.bin",
    };
  };
  const input = { path: "source.bin", target: "destination.bin" };
  const result = await executeFileOperation("copy", input, "ssh://sandbox/tmp", undefined, [
    resolver,
  ]);
  expect(result).toMatchObject({ ok: true, path: "ssh://sandbox/tmp/source.bin" });
  expect(calls).toEqual([
    { operation: "copy", input, context: { cwd: "ssh://sandbox/tmp", signal: undefined } },
  ]);
});

test("whole-file owner failures retain unknown effects instead of claiming no mutation", async () => {
  const result = await executeFileOperation(
    "copy",
    { path: "ssh://sandbox/source", target: "local" },
    "/local",
    undefined,
    [
      async () => {
        throw Object.assign(new Error("Transport lost after publication started"), {
          code: "CONNECTION_LOST",
          effect: "unknown",
        });
      },
    ],
  );
  expect(result).toMatchObject({
    ok: false,
    effect: "unknown",
    path: "ssh://sandbox/source",
    error: { code: "CONNECTION_LOST" },
  });
});

test("an owner throwing after a mutation cannot be reported as not applied", async () => {
  const cwd = await fixture();
  const result = await executeFileOperation("delete", { path: "source" }, cwd, undefined, [
    async () => {
      await writeFile(path.join(cwd, "partial"), "owner changed this");
      throw new Error("Reply failed");
    },
  ]);
  expect(result).toMatchObject({ ok: false, effect: "unknown" });
  expect(await readFile(path.join(cwd, "partial"), "utf8")).toBe("owner changed this");
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});

test("malformed whole-file owner results are unknown and never fall back locally", async () => {
  const cwd = await fixture();
  const result = await executeFileOperation("delete", { path: "source" }, cwd, undefined, [
    async () => ({ kind: "file-operation", operation: "copy", ok: true, effect: "applied" }),
  ]);
  expect(result).toMatchObject({
    ok: false,
    effect: "unknown",
    error: { code: "INVALID_PROVIDER_RESULT" },
  });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});

test("unclaimed URI operations fail without touching a similarly named local path", async () => {
  const cwd = await fixture();
  const misleading = path.join(cwd, "ssh:", "sandbox", "source");
  await mkdir(path.dirname(misleading), { recursive: true });
  await writeFile(misleading, "keep local");
  const result = await executeFileOperation("delete", { path: "ssh://sandbox/source" }, cwd);
  expect(result).toMatchObject({
    ok: false,
    effect: "not-applied",
    error: { code: "UNSUPPORTED_SOURCE" },
  });
  expect(await readFile(misleading, "utf8")).toBe("keep local");
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
    await executeFileOperation("delete", { path: "source" }, cwd, controller.signal),
  ).toMatchObject({ ok: false, effect: "not-applied" });
  expect(await readFile(path.join(cwd, "source"))).toEqual(Buffer.from([0, 255, 10]));
});
