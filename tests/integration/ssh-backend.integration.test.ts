import { chmod, link, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createContentRunner } from "pi-agent-resource";
import { createTextContentConverter } from "pi-agent-text";

import { SshBackend } from "#src/backend/ssh.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshResourceResolver } from "#src/backend/resource-resolver.js";
import { startSshFixture, type SshFixture } from "#integration/support/ssh-fixture.js";

let fixture: SshFixture;
let stopFixture: (() => Promise<void>) | undefined;
let backend: SshBackend;
beforeAll(async () => {
  fixture = await startSshFixture();
  stopFixture = () => fixture.stop();
  backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
});
afterAll(async () => {
  await stopFixture?.();
});

test("SSH copy and move create missing destination parents after preflight", async () => {
  const source = path.join(fixture.workspace, "parent-source.bin");
  await writeFile(source, Buffer.from([0, 255, 1]));
  await chmod(source, 0o644);
  const original = await backend.lstat(source);
  const refused = path.join(fixture.workspace, "refused-parents", "nested", "copy.bin");
  await expect(backend.copy(source, refused, "a".repeat(64), null)).rejects.toMatchObject({
    code: "CONFLICT",
    effect: "not-applied",
  });
  await expect(stat(path.dirname(refused))).rejects.toMatchObject({ code: "ENOENT" });
  const target = path.join(fixture.workspace, "copy-parents", "nested", "copy.bin");
  await backend.copy(source, target, original.revision, null);
  expect((await readFile(target)).equals(Buffer.from([0, 255, 1]))).toBe(true);
  const moved = path.join(fixture.workspace, "move-parents", "nested", "moved.bin");
  const current = await backend.lstat(source);
  await backend.move(source, moved, current.revision, null);
  expect((await backend.lstat(moved)).identity).toEqual(current.identity);
  await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
});
test("SSH journals keep large binary snapshots off the content transport", async () => {
  const filename = path.join(fixture.workspace, "journal-large.bin");
  const expected = Buffer.alloc(33 * 1024 * 1024 + 7, 255);
  expected.set([0, 13, 10, 239, 187, 191]);
  await writeFile(filename, expected);
  await chmod(filename, 0o644);
  const journal = await backend.captureJournal(filename);
  try {
    expect(journal.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(journal).not.toHaveProperty("bytes");
    expect((await readFile(journal.path)).equals(expected)).toBe(true);
    await writeFile(filename, "changed");
    const changed = await backend.lstat(filename);
    await backend.copy(journal.path, filename, journal.revision, changed.revision);
    expect((await readFile(filename)).equals(expected)).toBe(true);
    expect((await stat(filename)).mode & 0o777).toBe(0o644);
    const beforeExternal = await backend.lstat(filename);
    await writeFile(filename, "external");
    await expect(
      backend.copy(journal.path, filename, journal.revision, beforeExternal.revision),
    ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
    expect(await readFile(filename, "utf8")).toBe("external");
  } finally {
    await backend.releaseJournal(journal.directory);
  }
  await expect(stat(journal.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("SSH whole-file inspection distinguishes symlinks and hard-link identity without reading bytes", async () => {
  const filename = path.join(fixture.workspace, "inspect-large.bin");
  const hardLink = path.join(fixture.workspace, "inspect-hard-link.bin");
  const symbolicLink = path.join(fixture.workspace, "inspect-symbolic-link.bin");
  await writeFile(filename, Buffer.alloc(33 * 1024 * 1024, 65));
  await link(filename, hardLink);
  await symlink(filename, symbolicLink);
  const original = await backend.lstat(filename);
  const linked = await backend.lstat(hardLink);
  const symbolic = await backend.lstat(symbolicLink);
  expect(original).toMatchObject({ kind: "file", size: 33 * 1024 * 1024, links: 2 });
  expect(linked.identity).toEqual(original.identity);
  expect(symbolic.kind).toBe("symlink");
  expect(symbolic.identity).not.toEqual(original.identity);
  expect(await backend.stat(symbolicLink)).toMatchObject({ kind: "file" });
  expect(original.revision).toMatch(/^[a-f0-9]{64}$/u);
  await chmod(filename, 0o640);
  expect((await backend.lstat(filename)).revision).not.toBe(original.revision);
  await expect(
    backend.lstat(path.join(fixture.workspace, "inspect-missing")),
  ).rejects.toMatchObject({
    code: "ENOENT",
    effect: "not-applied",
  });
});

test("SSH file copies preserve large binary contents and reject stale or linked destinations", async () => {
  const filename = path.join(fixture.workspace, "copy-large.bin");
  const destination = path.join(fixture.workspace, "copy-destination.bin");
  const alias = path.join(fixture.workspace, "copy-alias.bin");
  const expected = Buffer.alloc(33 * 1024 * 1024 + 3, 255);
  expected.set([0, 13, 10], expected.length - 3);
  await writeFile(filename, expected);
  await chmod(filename, 0o644);
  const snapshot = await backend.lstat(filename);
  await backend.copy(filename, destination, snapshot.revision, null);
  expect((await readFile(destination)).equals(expected)).toBe(true);
  expect((await stat(destination)).mode & 0o777).toBe(0o644);
  await expect(backend.copy(filename, destination, snapshot.revision, null)).rejects.toMatchObject({
    code: "CONFLICT",
    effect: "not-applied",
  });
  await link(filename, alias);
  const current = await backend.lstat(filename);
  const linked = await backend.lstat(alias);
  await expect(
    backend.copy(filename, alias, current.revision, linked.revision),
  ).rejects.toMatchObject({
    code: "SAME_FILE",
    effect: "not-applied",
  });
  const before = await backend.lstat(destination);
  await writeFile(destination, "external");
  await expect(
    backend.copy(filename, destination, current.revision, before.revision),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    effect: "not-applied",
  });
  expect(await readFile(destination, "utf8")).toBe("external");
  const symbolic = path.join(fixture.workspace, "copy-symbolic.bin");
  await symlink(filename, symbolic);
  const symbolicSnapshot = await backend.lstat(symbolic);
  await expect(
    backend.copy(symbolic, destination, symbolicSnapshot.revision, null),
  ).rejects.toMatchObject({
    code: "INVALID_FILE_TYPE",
    effect: "not-applied",
  });
});

test("SSH whole-file moves keep the inode and guarded removal does not need a content snapshot", async () => {
  const filename = path.join(fixture.workspace, "move-large.bin");
  const destination = path.join(fixture.workspace, "move-large-destination.bin");
  await writeFile(filename, Buffer.alloc(33 * 1024 * 1024, 128));
  const before = await backend.lstat(filename);
  await backend.move(filename, destination, before.revision, null);
  await expect(backend.lstat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  const moved = await backend.lstat(destination);
  expect(moved.identity).toEqual(before.identity);
  expect(moved.size).toBe(before.size);
  await chmod(destination, 0o640);
  await expect(backend.removeEntry(destination, moved.revision)).rejects.toMatchObject({
    code: "CONFLICT",
    effect: "not-applied",
  });
  expect((await stat(destination)).size).toBe(before.size);
  const current = await backend.lstat(destination);
  await backend.removeEntry(destination, current.revision);
  await expect(backend.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const symbolic = path.join(fixture.workspace, "remove-link.bin");
  await symlink(filename, symbolic);
  const linked = await backend.lstat(symbolic);
  await expect(backend.removeEntry(symbolic, linked.revision)).rejects.toMatchObject({
    code: "INVALID_FILE_TYPE",
    effect: "not-applied",
  });
});

test("SSH moves across filesystems copy bytes before removing the guarded source", async () => {
  const created = await backend.execute(
    "python3",
    ["-c", "import tempfile; print(tempfile.mkdtemp(prefix='.tmp-pi-ide-ssh-', dir='/dev/shm'))"],
    fixture.workspace,
  );
  expect(created.exitCode).toBe(0);
  const directory = created.stdout.toString().trim();
  if (!/^\/dev\/shm\/\.tmp-pi-ide-ssh-[a-zA-Z0-9_-]+$/u.test(directory))
    throw new Error("Unexpected owned transfer workspace");
  const filename = path.join(fixture.workspace, "move-cross-device.bin");
  const destination = path.join(directory, "destination.bin");
  const expected = Buffer.from([0, 255, 128, 13, 10]);
  try {
    await writeFile(filename, expected);
    expect((await stat(filename)).dev).not.toBe((await stat(directory)).dev);
    const before = await backend.lstat(filename);
    await backend.move(filename, destination, before.revision, null);
    expect(await readFile(destination)).toEqual(expected);
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    const removed = await backend.execute(
      "python3",
      [
        "-c",
        "import os,sys; path=sys.argv[1]; os.unlink(path) if os.path.lexists(path) else None; os.rmdir(sys.argv[2])",
        destination,
        directory,
      ],
      fixture.workspace,
    );
    expect(removed.exitCode).toBe(0);
  }
});

test("SSH resources reuse content conversion and keep their own guarded write snapshot", async () => {
  const registry = new SshBackendRegistry([backend.target]);
  const target = { provider: "filesystem", capability: "write" } as const;
  const host = createContentRunner(target);
  host.register({ target, converter: createTextContentConverter(), priority: 300 });
  const resolver = createSshResourceResolver(registry, host, "write");
  const filename = path.join(fixture.workspace, "resource.txt");
  await backend.write(filename, Buffer.from("before\n"), null);
  const source = `ssh://fixture${filename}`;
  const resolved = await resolver.tryResolve(source, { cwd: "/local" });
  if (resolved.kind !== "resolved" || !resolved.resource.read || !resolved.resource.write)
    throw new Error("Missing read/write SSH resource");
  expect(resolved.resource.source).toBe(source);
  expect(await resolved.resource.read({})).toEqual([{ type: "text", text: "before\n" }]);
  await resolved.resource.write([{ type: "text", text: "after\n" }], {});
  expect(await readFile(filename, "utf8")).toBe("after\n");
  await writeFile(filename, "external\n");
  await expect(
    resolved.resource.write([{ type: "text", text: "stale\n" }], {}),
  ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
  expect(await readFile(filename, "utf8")).toBe("external\n");
  const directory = await resolver.tryResolve(`ssh://fixture${fixture.workspace}`, {
    cwd: "/local",
  });
  if (directory.kind !== "resolved") throw new Error("Missing directory resource");
  expect(directory.resource.write).toBeUndefined();
  const local = await resolver.tryResolve("/local/file", { cwd: "/local" });
  expect(local.kind).toBe("not-handled");
  const unknown = await resolver.tryResolve("ssh://unknown/file", { cwd: "/local" });
  expect(unknown.kind).toBe("failed");
});

test("SSH original byte reads cross the snapshot limit without invoking conversion", async () => {
  const registry = new SshBackendRegistry([backend.target]);
  const host = createContentRunner({ provider: "filesystem", capability: "read" });
  const resolver = createSshResourceResolver(registry, host, "read");
  const filename = path.join(fixture.workspace, "large-bytes.bin");
  const expected = Buffer.alloc(33 * 1024 * 1024 + 3, 255);
  expected.set([0, 13, 10], expected.length - 3);
  await writeFile(filename, expected);
  const resolved = await resolver.tryResolve(`ssh://fixture${filename}`, { cwd: "/local" });
  if (resolved.kind !== "resolved" || !resolved.resource.readBytes)
    throw new Error("Missing original byte reader");
  const full = await resolved.resource.readBytes(0, undefined, {});
  expect(full.byteOffset).toBe(0);
  expect(full.totalBytes).toBe(expected.length);
  expect(Buffer.from(full.bytes).equals(expected)).toBe(true);
  const tail = await resolved.resource.readBytes(-3, 2, {});
  expect(Array.from(tail.bytes)).toEqual([0, 13]);
  expect(tail.byteOffset).toBe(expected.length - 3);
  const empty = await resolved.resource.readBytes(expected.length + 100, 0, {});
  expect(empty.bytes.length).toBe(0);
  expect(empty.byteOffset).toBe(expected.length);
});

test("SSH byte reads reject a same-size external change between chunks", async () => {
  const registry = new SshBackendRegistry([backend.target]);
  const host = createContentRunner({ provider: "filesystem", capability: "read" });
  const resolver = createSshResourceResolver(registry, host, "read");
  const filename = path.join(fixture.workspace, "changing-bytes.bin");
  const source = `ssh://fixture${filename}`;
  const owner = registry.resolve(source);
  if (!owner) throw new Error("Missing SSH target");
  await writeFile(filename, Buffer.alloc(5 * 1024 * 1024, 65));
  const originalRead = owner.backend.readRange.bind(owner.backend);
  let changed = false;
  const intercepted = vi.spyOn(owner.backend, "readRange").mockImplementation(async (...args) => {
    const range = await originalRead(...args);
    if (!changed) {
      changed = true;
      await writeFile(filename, Buffer.alloc(5 * 1024 * 1024, 66));
    }
    return range;
  });
  try {
    const resolved = await resolver.tryResolve(source, { cwd: "/local" });
    if (resolved.kind !== "resolved" || !resolved.resource.readBytes)
      throw new Error("Missing original byte reader");
    const outcome = await resolved.resource.readBytes(0, undefined, {}).then(
      () => ({ kind: "resolved" }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { code: "SOURCE_CHANGED", effect: "not-applied" },
    });
  } finally {
    intercepted.mockRestore();
  }
});

test("parallel SSH commits serialize and only one can consume the same snapshot", async () => {
  const filename = path.join(fixture.workspace, "parallel.txt");
  const version = await backend.write(filename, Buffer.from("before"), null);
  const results = await Promise.allSettled([
    backend.write(filename, Buffer.from("one"), version),
    backend.write(filename, Buffer.from("two"), version),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toMatchObject([
    { reason: { code: "CONFLICT", effect: "not-applied" } },
  ]);
  const current = await backend.read(filename);
  await backend.remove(filename, current.version);
  await expect(backend.read(filename)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a transport deadline reports an uncertain command effect, not a made-up program exit", async () => {
  await expect(
    backend.execute("python3", ["-c", "import time; time.sleep(5)"], fixture.workspace, {
      timeoutMs: 500,
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT", effect: "unknown" });
});

test("SSH byte snapshots and writes preserve reserved filenames without shell interpolation", async () => {
  const filename = path.join(fixture.workspace, "bytes", "a '$(touch INJECTED)' #é.bin");
  const bytes = Buffer.from([0, 255, 10, 128, 13]);
  const version = await backend.write(filename, bytes, null);
  const snapshot = await backend.read(filename);
  expect(snapshot.bytes).toEqual(bytes);
  expect(snapshot.version).toBe(version);
  expect(await backend.readRange(filename, -2, 2)).toEqual({
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
    bytes: Buffer.from([128, 13]),
    offset: 3,
    totalBytes: 5,
  });
  expect((await backend.list(path.dirname(filename))).map((item) => item.name)).toEqual([
    path.basename(filename),
  ]);
  expect(await readFile(filename)).toEqual(bytes);
});

test("SSH range windows clamp offsets to the opened file size", async () => {
  const filename = path.join(fixture.workspace, "range.txt");
  await backend.write(filename, Buffer.from("abc"), null);
  expect(await backend.readRange(filename, 100, 5)).toEqual({
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
    bytes: Buffer.alloc(0),
    offset: 3,
    totalBytes: 3,
  });
  expect(await backend.readRange(filename, -100, 2)).toEqual({
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
    bytes: Buffer.from("ab"),
    offset: 0,
    totalBytes: 3,
  });
});

test("SSH short commands reject excessive output without returning partial success", async () => {
  await expect(
    backend.execute(
      "python3",
      ["-c", "import os; chunk=b'x'*65536;\nwhile True: os.write(1, chunk)"],
      fixture.workspace,
    ),
  ).rejects.toMatchObject({ code: "CONTENT_LIMIT", effect: "unknown" });
});

test("an external change is rejected rather than restored over by a stale SSH write", async () => {
  const filename = path.join(fixture.workspace, "stale.txt");
  await backend.write(filename, Buffer.from("before\n"), null);
  const before = await backend.read(filename);
  await writeFile(filename, "external\n");
  await expect(
    backend.write(filename, Buffer.from("edited\n"), before.version),
  ).rejects.toMatchObject({ code: "CONFLICT", effect: "not-applied" });
  expect(await readFile(filename, "utf8")).toBe("external\n");
  await expect(backend.write(filename, Buffer.from("new\n"), null)).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("replacing a file with identical bytes still invalidates its SSH snapshot", async () => {
  const filename = path.join(fixture.workspace, "recreated.txt");
  const version = await backend.write(filename, Buffer.from("same"), null);
  await backend.remove(filename, version);
  await backend.write(filename, Buffer.from("same"), null);
  await expect(backend.write(filename, Buffer.from("wrong inode"), version)).rejects.toMatchObject({
    code: "CONFLICT",
    effect: "not-applied",
  });
  expect(await readFile(filename, "utf8")).toBe("same");
});

test("SSH replacement preserves hard-link identity and updates every linked name", async () => {
  const filename = path.join(fixture.workspace, "hardlink.txt");
  const alias = path.join(fixture.workspace, "hardlink-alias.txt");
  const version = await backend.write(filename, Buffer.from("before"), null);
  await link(filename, alias);
  const before = await backend.read(filename);
  const inode = (await stat(filename)).ino;
  await expect(backend.write(filename, Buffer.from("stale"), version)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await backend.write(filename, Buffer.from("after"), before.version);
  expect(await readFile(alias, "utf8")).toBe("after");
  expect((await stat(filename)).ino).toBe(inode);
  expect((await stat(alias)).ino).toBe(inode);
});

test("SSH atomic replacement retains extended file attributes", async () => {
  const filename = path.join(fixture.workspace, "xattrs.txt");
  await backend.write(filename, Buffer.from("before"), null);
  const setup = await backend.execute(
    "python3",
    ["-c", "import os,sys; os.setxattr(sys.argv[1], 'user.pi_ide_test', b'value')", filename],
    fixture.workspace,
  );
  expect(setup.exitCode).toBe(0);
  await backend.write(filename, Buffer.from("after"), (await backend.read(filename)).version);
  const inspected = await backend.execute(
    "python3",
    ["-c", "import os,sys; print(os.getxattr(sys.argv[1], 'user.pi_ide_test').decode())", filename],
    fixture.workspace,
  );
  expect(inspected.exitCode).toBe(0);
  expect(inspected.stdout.toString()).toBe("value\n");
});

test("SSH text replacement follows the symlink target and preserves file permissions", async () => {
  const filename = path.join(fixture.workspace, "target.txt");
  await backend.write(filename, Buffer.from("before"), null);
  const link = path.join(fixture.workspace, "link.txt");
  await symlink(filename, link);
  const before = await backend.read(link);
  await backend.write(link, Buffer.from("after"), before.version);
  expect(await readFile(filename, "utf8")).toBe("after");
  await expect(backend.remove(link, before.version)).rejects.toMatchObject({
    code: "INVALID_FILE_TYPE",
  });
  await chmod(filename, 0o444);
  const current = await backend.read(filename);
  await expect(
    backend.write(filename, Buffer.from("denied"), current.version),
  ).rejects.toMatchObject({ code: "EACCES", effect: "not-applied" });
  expect(await readFile(filename, "utf8")).toBe("after");
});

test("SSH command execution keeps remote cwd, arguments and nonzero program exits", async () => {
  const result = await backend.execute(
    "python3",
    [
      "-c",
      "import os,sys; print(os.getcwd()); print(sys.argv[1]); print(os.getuid()); sys.exit(7)",
      "literal; $(false)",
    ],
    fixture.workspace,
  );
  expect(result.exitCode).toBe(7);
  expect(result.stdout.toString()).toContain(`${fixture.workspace}\nliteral; $(false)\n`);
  expect(result.stdout.toString()).not.toContain("\n0\n");
});

test("missing paths, unknown host keys and denied authentication are distinct sanitized failures", async () => {
  await expect(backend.read(path.join(fixture.workspace, "missing"))).rejects.toMatchObject({
    code: "ENOENT",
    effect: "not-applied",
  });
  const config = path.join(fixture.root, "untrusted_config");
  const trusted = await readFile(fixture.config, "utf8");
  await writeFile(
    config,
    trusted.replace(/UserKnownHostsFile .*/u, "UserKnownHostsFile /dev/null"),
  );
  const untrusted = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: config,
  });
  await expect(untrusted.read(fixture.workspace)).rejects.toMatchObject({
    code: "HOST_KEY_FAILED",
    effect: "not-applied",
  });
  await writeFile(
    config,
    trusted.replace(/IdentityFile .*/u, `IdentityFile ${path.join(fixture.root, "host")}`),
  );
  await expect(untrusted.read(fixture.workspace)).rejects.toMatchObject({
    code: "AUTH_FAILED",
    effect: "not-applied",
  });
  try {
    await untrusted.read("/requested-file");
  } catch (error) {
    expect(String(error)).not.toContain(fixture.root);
    expect(String(error)).not.toContain("PRIVATE KEY");
  }
});
