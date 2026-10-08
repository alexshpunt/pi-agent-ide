import { createHash } from "node:crypto";
import { chmod, link, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { SshBackend } from "#src/backend/ssh.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";

test("SSH journal restoration rejects a destination changed after capture", async () => {
  const fixture = await startSshFixture();
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const filename = path.join(fixture.workspace, "captured.bin");
  let directory: string | undefined;
  try {
    await writeFile(filename, "before");
    const journal = await backend.captureJournal(filename);
    directory = journal.directory;
    await writeFile(filename, "external");
    await expect(
      backend.restoreJournal(journal.path, filename, journal.revision, journal.sourceRevision),
    ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
    expect(await readFile(filename, "utf8")).toBe("external");
  } finally {
    if (directory !== undefined) await backend.releaseJournal(directory);
    await fixture.stop();
  }
}, 60000);

test("SSH journal restore preserves hard-linked aliases and their inode", async () => {
  const fixture = await startSshFixture();
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const filename = path.join(fixture.workspace, "linked-undo.bin");
  const alias = `${filename}.alias`;
  let directory: string | undefined;
  try {
    await backend.write(filename, new TextEncoder().encode("before"), null);
    await chmod(filename, 0o666);
    await link(filename, alias);
    await utimes(filename, 1234567890.123, 1234567891.456);
    const original = await stat(filename, { bigint: true });
    const inode = (await stat(filename)).ino;
    const journal = await backend.captureJournal(filename);
    directory = journal.directory;
    await writeFile(filename, "after");
    const observed = await backend.lstat(filename);
    await backend.restoreJournal(journal.path, filename, journal.revision, observed.revision);
    const restored = await stat(filename, { bigint: true });
    expect(restored.atimeNs).toBe(original.atimeNs);
    expect(restored.mtimeNs).toBe(original.mtimeNs);
    expect(await readFile(alias, "utf8")).toBe("before");
    expect((await stat(filename)).ino).toBe(inode);
    expect((await stat(alias)).ino).toBe(inode);
  } finally {
    if (directory !== undefined) await backend.releaseJournal(directory);
    await fixture.stop();
  }
}, 60000);

test("SSH disk journals restore large files and release their owned backups", async () => {
  const fixture = await startSshFixture();
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const filename = path.join(fixture.workspace, "large-undo.bin");
  const bytes = Buffer.alloc(33 * 1024 * 1024 + 3, 255);
  bytes.set([0, 239, 187, 191, 13, 10]);
  let directory: string | undefined;
  try {
    await writeFile(filename, bytes);
    await chmod(filename, 0o644);
    const journal = await backend.captureJournal(filename);
    directory = journal.directory;
    expect(journal.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    await backend.removeEntry(filename, journal.sourceRevision);
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await backend.restoreJournal(journal.path, filename, journal.revision, null);
    expect((await readFile(filename)).equals(bytes)).toBe(true);
    expect((await stat(filename)).mode & 0o777).toBe(0o644);
    await backend.releaseJournal(directory);
    await backend.releaseJournal(directory);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    directory = undefined;
  } finally {
    if (directory !== undefined) await backend.releaseJournal(directory);
    await fixture.stop();
  }
}, 60000);
