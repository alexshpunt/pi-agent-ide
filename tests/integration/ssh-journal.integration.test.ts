import { createHash } from "node:crypto";
import { chmod, link, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { ApplyFileAccess } from "pi-agent-text-editor/api/plugin-protocol";
import { createSshApplyFileAccessProvider } from "#src/backend/apply-file-access.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";

const unowned = (): never => {
  throw new Error("SSH owner must not delegate");
};
const fallback: ApplyFileAccess = {
  resolve: (_cwd, source) => source,
  capture: async () => unowned(),
  readText: async () => unowned(),
  restore: async () => unowned(),
  validateFile: async () => unowned(),
  performFile: async () => unowned(),
};

test("Apply file effects reject changes after journal capture", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry(
    ["fixture", "other"].map((id) => ({
      id,
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    })),
  );
  const provider = createSshApplyFileAccessProvider(registry);
  const access = provider(fallback, { cwd: fixture.workspace });
  const sourcePath = path.join(fixture.workspace, "captured-source.bin");
  const targetPath = path.join(fixture.workspace, "captured-target.bin");
  const source = `ssh://fixture${sourcePath}`;
  try {
    for (const targetId of ["fixture", "other"]) {
      const target = `ssh://${targetId}${targetPath}`;
      await writeFile(sourcePath, "before");
      await writeFile(targetPath, "target before");
      await access.capture(source);
      await access.capture(target);
      await writeFile(sourcePath, "source external");
      await expect(
        access.performFile(
          { kind: "copy", path: source, target, overwrite: true },
          fixture.workspace,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
      expect(await readFile(targetPath, "utf8")).toBe("target before");
      await access.capture(source);
      await writeFile(targetPath, "target external");
      await expect(
        access.performFile(
          { kind: "copy", path: source, target, overwrite: true },
          fixture.workspace,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
      expect(await readFile(targetPath, "utf8")).toBe("target external");
    }
  } finally {
    await provider.dispose();
    await fixture.stop();
  }
}, 60000);

test("SSH journal restore preserves hard-linked aliases and their inode", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const provider = createSshApplyFileAccessProvider(registry);
  const access = provider(fallback, { cwd: fixture.workspace });
  const filename = path.join(fixture.workspace, "linked-undo.bin");
  const alias = `${filename}.alias`;
  const source = `ssh://fixture${filename}`;
  try {
    const owned = registry.resolve(source);
    if (owned === undefined) throw new Error("Missing owner");
    await owned.backend.write(filename, new TextEncoder().encode("before"), null);
    await chmod(filename, 0o666);
    await link(filename, alias);
    await utimes(filename, 1234567890.123, 1234567891.456);
    const original = await stat(filename, { bigint: true });
    const inode = (await stat(filename)).ino;
    const before = await access.capture(source);
    await writeFile(filename, "after");
    await access.capture(source);
    await access.restore(before);
    const restored = await stat(filename, { bigint: true });
    expect(restored.atimeNs).toBe(original.atimeNs);
    expect(restored.mtimeNs).toBe(original.mtimeNs);
    expect(await readFile(alias, "utf8")).toBe("before");
    expect((await stat(filename)).ino).toBe(inode);
    expect((await stat(alias)).ino).toBe(inode);
  } finally {
    await provider.dispose();
    await fixture.stop();
  }
}, 60000);
test("Apply file owners restore large SSH journals and release all owned backups", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const provider = createSshApplyFileAccessProvider(registry);
  const access = provider(fallback, { cwd: fixture.workspace });
  const filename = path.join(fixture.workspace, "large-undo.bin");
  const source = `ssh://fixture${filename}`;
  const owned = registry.resolve(source);
  if (owned === undefined) throw new Error("Missing owner");
  const directories: string[] = [];
  const captureJournal = owned.backend.captureJournal.bind(owned.backend);
  owned.backend.captureJournal = async (...args) => {
    const journal = await captureJournal(...args);
    directories.push(journal.directory);
    return journal;
  };
  const bytes = Buffer.alloc(33 * 1024 * 1024 + 3, 255);
  bytes.set([0, 239, 187, 191, 13, 10]);
  try {
    await writeFile(filename, bytes);
    await chmod(filename, 0o644);
    const before = await access.capture(source);
    expect(before.bytes).toBeUndefined();
    expect(before.backup?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    await access.performFile({ kind: "delete", path: source }, fixture.workspace);
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
    await access.restore(before);
    expect((await readFile(filename)).equals(bytes)).toBe(true);
    expect((await stat(filename)).mode & 0o777).toBe(0o644);
    const observed = await access.capture(source);
    await writeFile(filename, "external");
    await expect(access.restore(before)).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "not-applied",
    });
    expect(await readFile(filename, "utf8")).toBe("external");
    await observed.backup?.release();
    await observed.backup?.release();
  } finally {
    await provider.dispose();
    await fixture.stop();
  }
  for (const directory of directories)
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 60000);
