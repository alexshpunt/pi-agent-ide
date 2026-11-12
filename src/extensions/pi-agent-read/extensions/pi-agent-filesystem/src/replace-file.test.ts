import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { replaceFileContent } from "./replace-file.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "pi-agent-replace-file-"));
  directories.push(created);
  return created;
}

test("a file is replaced in one step and keeps its permissions", async () => {
  const root = await directory();
  const file = path.join(root, "source.ts");
  await writeFile(file, "before\n");
  await chmod(file, 0o640);
  const before = await stat(file);

  await replaceFileContent(file, Buffer.from("after\n"), undefined);

  const after = await stat(file);
  expect(await readFile(file, "utf8")).toBe("after\n");
  // A new file took the old one's place, so a reader saw one complete version or the other.
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o640);
  expect(await readdir(root)).toEqual(["source.ts"]);
});

test.runIf(process.platform !== "win32")(
  "a replaced file keeps permissions that the process umask would remove",
  async () => {
    const root = await directory();
    const file = path.join(root, "source.ts");
    await writeFile(file, "before\n");
    await chmod(file, 0o664);
    const previous = process.umask(0o077);
    try {
      await replaceFileContent(file, Buffer.from("after\n"), undefined);
    } finally {
      process.umask(previous);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o664);
  },
);

test.runIf(process.platform !== "win32")(
  "a file with another hard link and a symlinked file are written where they are",
  async () => {
    const root = await directory();
    const file = path.join(root, "source.ts");
    const hardLink = path.join(root, "linked.ts");
    const symbolicLink = path.join(root, "alias.ts");
    await writeFile(file, "before\n");
    await link(file, hardLink);
    await symlink(file, symbolicLink);

    await replaceFileContent(file, Buffer.from("through file\n"), undefined);
    expect(await readFile(hardLink, "utf8")).toBe("through file\n");

    await replaceFileContent(symbolicLink, Buffer.from("through link\n"), undefined);
    expect(await readFile(file, "utf8")).toBe("through link\n");
    expect((await lstat(symbolicLink)).isSymbolicLink()).toBe(true);
    expect(await readdir(root)).toEqual(["alias.ts", "linked.ts", "source.ts"]);
  },
);

test("a new file is created", async () => {
  const root = await directory();
  const file = path.join(root, "new.ts");

  await replaceFileContent(file, Buffer.from("created\n"), undefined);

  expect(await readFile(file, "utf8")).toBe("created\n");
});

test("a reader running during repeated writes always sees one complete version", async () => {
  const root = await directory();
  const file = path.join(root, "large.ts");
  const versions = ["a", "b", "c", "d"].map((letter) => Buffer.from(letter.repeat(2_000_000)));
  await writeFile(file, versions[0] ?? "");
  const writing = (async () => {
    for (let round = 0; round < 40; round += 1)
      await replaceFileContent(
        file,
        versions[round % versions.length] ?? Buffer.alloc(0),
        undefined,
      );
  })();
  const state = { writing: true };
  void writing.finally(() => {
    state.writing = false;
  });
  const sizes = new Set<number>();
  while (state.writing) sizes.add((await readFile(file)).length);
  await writing;

  expect([...sizes]).toEqual([2_000_000]);
});
