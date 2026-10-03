import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resourceAccesses } from "./resource-access.js";

test("relative paths, file URLs, symlinks, and hard links share a file identity", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "resource-access-"));
  try {
    const file = path.join(cwd, "file.txt");
    await writeFile(file, "text");
    await symlink(file, path.join(cwd, "alias.txt"));
    await link(file, path.join(cwd, "hard.txt"));
    const original = await resourceAccesses(file, cwd, "write");
    for (const source of ["file.txt", pathToFileURL(file).href, "alias.txt", "hard.txt"]) {
      const alias = await resourceAccesses(source, cwd, "write");
      expect(
        alias.some((entry) => original.some((other) => entry.resource === other.resource)),
      ).toBe(true);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("new files inside a symlinked parent keep the same path identity", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "resource-access-"));
  try {
    await mkdir(path.join(cwd, "real"));
    await symlink(path.join(cwd, "real"), path.join(cwd, "alias"));
    const first = await resourceAccesses("real/new/deep.txt", cwd, "write");
    const second = await resourceAccesses("alias/new/deep.txt", cwd, "write");
    expect(second).toEqual(first);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
