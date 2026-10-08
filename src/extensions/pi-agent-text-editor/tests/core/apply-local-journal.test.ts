import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  captureLocalFileState,
  createLocalFileJournal,
  restoreLocalFileState,
} from "#src/core/apply/local-journal.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.resolve(".tmp/local-journal-"));
  roots.push(root);
  return path.join(root, "large.bin");
}

test("local Apply snapshots keep large binary files on disk and restore their mode", async () => {
  const file = await fixture();
  const bytes = Buffer.alloc(33 * 1024 * 1024 + 3, 0xff);
  bytes.set([0, 1, 2]);
  await writeFile(file, bytes);
  await chmod(file, 0o640);
  const before = await captureLocalFileState(file);
  try {
    expect(before.bytes).toBeUndefined();
    expect(before.backup?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    await writeFile(file, "after");
    await chmod(file, 0o600);
    const after = await captureLocalFileState(file);
    try {
      await restoreLocalFileState(before);
      expect((await readFile(file)).equals(bytes)).toBe(true);
      expect((await stat(file)).mode & 0o777).toBe(0o640);
    } finally {
      await after.backup?.release();
    }
  } finally {
    await before.backup?.release();
    await before.backup?.release();
  }
});

test("local journal restore refuses a change after its final captured state", async () => {
  const file = await fixture();
  await writeFile(file, "before");
  const before = await captureLocalFileState(file);
  await writeFile(file, "after");
  const after = await captureLocalFileState(file);
  try {
    await writeFile(file, "external");
    await expect(restoreLocalFileState(before)).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "not-applied",
    });
    expect(await readFile(file, "utf8")).toBe("external");
  } finally {
    await before.backup?.release();
    await after.backup?.release();
  }
});

test("local restore reports unknown when publication succeeded but acknowledgement failed", async () => {
  const file = await fixture();
  await writeFile(file, "before");
  let published = false;
  const journal = createLocalFileJournal({
    async rename(source, target) {
      await rename(source, target);
      published = true;
    },
    async lstat(source, options) {
      if (published) throw Object.assign(new Error("Acknowledgement unavailable"), { code: "EIO" });
      return lstat(source, options);
    },
  });
  const before = await journal.capture(file);
  await writeFile(file, "after");
  const after = await journal.capture(file);
  try {
    await expect(journal.restore(before)).rejects.toMatchObject({
      code: "RESTORE_FAILED",
      effect: "unknown",
    });
    expect(await readFile(file, "utf8")).toBe("before");
  } finally {
    await before.backup?.release();
    await after.backup?.release();
  }
});

test("local undo keeps hard-linked names on the same restored inode", async () => {
  const file = await fixture();
  const alias = `${file}.alias`;
  await writeFile(file, "before");
  await link(file, alias);
  const inode = (await stat(file)).ino;
  const journal = createLocalFileJournal();
  const before = await journal.capture(file);
  await writeFile(file, "after");
  const after = await journal.capture(file);
  try {
    await journal.restore(before);
    expect(await readFile(alias, "utf8")).toBe("before");
    expect((await stat(file)).ino).toBe(inode);
    expect((await stat(alias)).ino).toBe(inode);
  } finally {
    await before.backup?.release();
    await after.backup?.release();
  }
});
test("local journal owners do not accept another owner's backup", async () => {
  const file = await fixture();
  await writeFile(file, "before");
  const owner = createLocalFileJournal();
  const other = createLocalFileJournal();
  const before = await owner.capture(file);
  await writeFile(file, "after");
  const current = await other.capture(file);
  try {
    await expect(other.restore(before)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
      effect: "not-applied",
    });
    expect(await readFile(file, "utf8")).toBe("after");
  } finally {
    await before.backup?.release();
    await current.backup?.release();
  }
});
