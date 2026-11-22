import { expect, test } from "vitest";
import type { FileObjectEntry, FileTransferAccess } from "#src/api/file-transfers.ts";
import { assertUnprotectedTransferPath } from "#src/core/delete-policy.ts";
import { prepareObjectTransfer } from "#src/core/file-transfers.ts";

/** A target whose paths look like a Windows target's: `/C:/...`, with no directory above `/C:`. */
function windowsOwner(
  files: Readonly<Record<string, number>>,
  options: { caseInsensitive?: boolean } = {},
): FileTransferAccess {
  const missing = (code: string) => Object.assign(new Error(code), { code });
  const valid = (file: string) => /^\/[A-Za-z]:(?:\/|$)/u.test(file);
  const entry = (file: string): Omit<FileObjectEntry, "relativePath" | "link"> => {
    const inode = files[file];
    if (!valid(file)) throw missing("INVALID_PATH");
    if (inode === undefined) throw missing("ENOENT");
    return {
      kind: "file",
      revision: `revision:${file}`,
      identity: { device: "1", inode: String(inode) },
      mode: 0o644,
    };
  };
  return {
    owner: "windows-target",
    ...options,
    realpath: async (file) => {
      if (!valid(file)) throw missing("INVALID_PATH");
      return file;
    },
    inspect: async (file) => entry(file),
    read: async () => {
      throw missing("ENOENT");
    },
    git: async () => {
      throw new Error("Git is not available");
    },
    source: (file) => `ssh://windows${file}`,
    snapshot: async (file) =>
      files[file] === undefined
        ? { path: file, entries: [] }
        : { path: file, entries: [{ relativePath: "", ...entry(file) }] },
  };
}

test("a project walk stops at the drive root instead of probing a directory above it", async () => {
  const files = windowsOwner({ "/C:/work/a.txt": 1 });
  await expect(
    assertUnprotectedTransferPath("/C:/work/b.txt", "/C:/work", undefined, files),
  ).resolves.toBeUndefined();
});

test("a drive root is protected like a filesystem root", async () => {
  const files = windowsOwner({});
  for (const root of ["/C:", "/C:/", "/d:"])
    await expect(
      assertUnprotectedTransferPath(root, "/C:/work", undefined, files),
    ).rejects.toMatchObject({ code: "DELETE_PROTECTED_TARGET" });
});

test("renaming a file to another spelling of its name is a move on a case-insensitive target", async () => {
  const files = { "/C:/work/note.txt": 7, "/C:/work/NOTE.txt": 7 };
  const move = (access: FileTransferAccess) =>
    prepareObjectTransfer(
      "move",
      { path: "/C:/work/note.txt", cwd: "/C:/work", files: access },
      { path: "/C:/work/NOTE.txt", cwd: "/C:/work", files: access },
      {},
    );
  await expect(move(windowsOwner(files, { caseInsensitive: true }))).resolves.toMatchObject({
    sourceKind: "file",
  });
  // The same pair of names on a case-sensitive owner is two hard links to one file.
  await expect(move(windowsOwner(files))).rejects.toMatchObject({ code: "SAME_FILE" });
});

test("a copy onto another spelling of the same file is still the same file", async () => {
  const files = { "/C:/work/note.txt": 7, "/C:/work/NOTE.txt": 7 };
  const access = windowsOwner(files, { caseInsensitive: true });
  await expect(
    prepareObjectTransfer(
      "copy",
      { path: "/C:/work/note.txt", cwd: "/C:/work", files: access },
      { path: "/C:/work/NOTE.txt", cwd: "/C:/work", files: access },
      {},
    ),
  ).rejects.toMatchObject({ code: "SAME_FILE" });
});
