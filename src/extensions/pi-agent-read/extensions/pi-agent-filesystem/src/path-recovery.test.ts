import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { recoverFilesystemPath } from "#src/path-recovery.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = path.resolve(".tmp/path-recovery-unit");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "workspace-"));
  directories.push(directory);
  return directory;
}

function missing(source: string, code = "ENOENT") {
  return {
    code: "READ_FAILED" as const,
    source,
    message: "Original read failure",
    cause: Object.assign(new Error("missing"), { code }),
  };
}

test("ranks matching filenames and prefers the requested directory, with at most three hints", async () => {
  const cwd = await workspace();
  for (const folder of ["z", "a", "b", "c"]) {
    await mkdir(path.join(cwd, folder));
    await writeFile(path.join(cwd, folder, "renderer.ts"), "candidate content");
  }
  expect(await recoverFilesystemPath(missing("z/rendere.ts"), { cwd })).toEqual([
    { path: "z/renderer.ts" },
    { path: "a/renderer.ts" },
    { path: "b/renderer.ts" },
  ]);
});

test("respects ignore files and rejects symlinks that leave the workspace", async () => {
  const cwd = await workspace();
  const outside = await workspace();
  await writeFile(path.join(cwd, ".gitignore"), "ignored.ts\n");
  await writeFile(path.join(cwd, "ignored.ts"), "ignored");
  await writeFile(path.join(outside, "external.ts"), "outside");
  await symlink(path.join(outside, "external.ts"), path.join(cwd, "external.ts"));
  expect(await recoverFilesystemPath(missing("ignore.ts"), { cwd })).toBeUndefined();
  expect(await recoverFilesystemPath(missing("externa.ts"), { cwd })).toBeUndefined();
  expect(
    await recoverFilesystemPath(missing(path.join(outside, "externa.ts")), { cwd }),
  ).toBeUndefined();
});

test("keeps unrelated, permission, and cancelled failures without hints", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "renderer.ts"), "candidate");
  expect(await recoverFilesystemPath(missing("unrelated.xyz"), { cwd })).toBeUndefined();
  expect(await recoverFilesystemPath(missing("rendere.ts", "EACCES"), { cwd })).toBeUndefined();
  expect(
    await recoverFilesystemPath(missing("rendere.ts"), { cwd, signal: AbortSignal.abort() }),
  ).toBeUndefined();
});
