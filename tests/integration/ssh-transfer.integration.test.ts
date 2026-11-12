import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createSshFileOperationResolver } from "#src/backend/file-operation-resolver.ts";
import { TRANSFER_STALL_MS } from "#src/backend/file-transfer.ts";
import { SshBackendRegistry } from "#src/backend/registry.ts";
import { remoteLocation } from "#src/backend/identity.ts";
import { SshBackend } from "#src/backend/ssh.ts";
import { startSshProcess } from "#src/backend/ssh-channel.ts";
import {
  neutralDirectory,
  remotePython,
  sshTransferProgram,
  targetOs,
} from "#src/backend/ssh-transport.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";
import { sshTransferPolicy } from "#integration/support/ssh-transfer-policy.ts";

test("streamed transfers preserve external edits and clean unpublished staging files", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry(
    ["left", "right"].map((id) => ({
      id,
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    })),
  );
  const resolver = createSshFileOperationResolver(registry);
  const operate: typeof resolver = (operation, input, context) =>
    resolver(operation, input, context, sshTransferPolicy);
  const sourcePath = path.join(fixture.workspace, "source.bin");
  const targetPath = path.join(fixture.workspace, "target.bin");
  const source = remoteLocation("left", sourcePath).source;
  const target = remoteLocation("right", targetPath).source;
  const owned = registry.resolve(source);
  if (owned === undefined) throw new Error("Missing source owner");
  const originalRead = owned.backend.readStream.bind(owned.backend);
  const before = Buffer.alloc(2 * 1024 * 1024, 65);
  try {
    for (const changed of ["source", "target"] as const) {
      await writeFile(sourcePath, before);
      await writeFile(targetPath, "before target");
      let injected = false;
      // Edit an endpoint after the first streamed chunk, while the transfer is in flight.
      owned.backend.readStream = (filePath, revision, consume, context) =>
        originalRead(
          filePath,
          revision,
          async (bytes) => {
            await consume(bytes);
            if (!injected) {
              injected = true;
              await writeFile(changed === "source" ? sourcePath : targetPath, "external edit");
            }
          },
          context,
        );
      await expect(
        operate("copy", { path: source, target }, { cwd: fixture.workspace }),
      ).rejects.toMatchObject({
        code: changed === "target" ? "TRANSFER_TARGET_CHANGED" : "CONFLICT",
        effect: "not-applied",
      });
      expect(await readFile(targetPath, "utf8")).toBe(
        changed === "target" ? "external edit" : "before target",
      );
      if (changed === "source") expect(await readFile(sourcePath, "utf8")).toBe("external edit");
      expect(
        (await readdir(fixture.workspace)).some((name) => name.startsWith(".pi-ide-transfer-")),
      ).toBe(false);
    }
  } finally {
    owned.backend.readStream = originalRead;
    await fixture.stop();
  }
}, 60000);

test.each(["download", "targets"] as const)(
  "a cancelled %s transfer reports the bytes it wrote and keeps the target file",
  async (route) => {
    const fixture = await startSshFixture();
    const registry = new SshBackendRegistry(
      ["left", "right"].map((id) => ({
        id,
        host: "fixture",
        workspace: fixture.workspace,
        configFile: fixture.config,
      })),
    );
    const operate = createSshFileOperationResolver(registry);
    const remote = path.join(fixture.workspace, "source.bin");
    const actualTarget =
      route === "download"
        ? path.join(fixture.root, "target.bin")
        : path.join(fixture.workspace, "target.bin");
    const source = remoteLocation("left", remote).source;
    const target =
      route === "download" ? actualTarget : remoteLocation("right", actualTarget).source;
    const owned = registry.resolve(source);
    if (owned === undefined) throw new Error("Missing source owner");
    const originalRead = owned.backend.readStream.bind(owned.backend);
    const controller = new AbortController();
    // Cancel after the second 1 MiB chunk. A remote target may still be acknowledging that chunk,
    // but the first one is confirmed before the second is consumed.
    let chunks = 0;
    owned.backend.readStream = (filePath, revision, consume, context) =>
      originalRead(
        filePath,
        revision,
        async (bytes) => {
          await consume(bytes);
          if (++chunks === 2) controller.abort();
        },
        context,
      );
    try {
      await writeFile(remote, Buffer.alloc(3 * 1024 * 1024, 7));
      await writeFile(actualTarget, "old destination");
      const failure = operate(
        "copy",
        { path: source, target },
        { cwd: fixture.root, signal: controller.signal },
        sshTransferPolicy,
      );
      const error: unknown = await failure.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "CANCELLED",
        effect: "not-applied",
        totalBytes: 3 * 1024 * 1024,
      });
      const written = route === "download" ? [2 * 1024 * 1024] : [1024 * 1024, 2 * 1024 * 1024];
      expect(written).toContain((error as { transferredBytes: number }).transferredBytes);
      // The visible message carries the progress, not only the structured fields.
      expect((error as Error).message).toMatch(/\b(1048576|2097152) of 3145728 bytes\b/u);
      expect(await readFile(actualTarget, "utf8")).toBe("old destination");
      expect(
        (await readdir(path.dirname(actualTarget))).some((name) =>
          name.startsWith(".pi-ide-transfer-"),
        ),
      ).toBe(false);
    } finally {
      owned.backend.readStream = originalRead;
      await fixture.stop();
    }
  },
  90000,
);

test("a transfer that stops moving data fails as stalled with the bytes it wrote", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "left", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const operate = createSshFileOperationResolver(registry);
  const remote = path.join(fixture.workspace, "source.bin");
  const local = path.join(fixture.root, "target.bin");
  const source = remoteLocation("left", remote).source;
  const owned = registry.resolve(source);
  if (owned === undefined) throw new Error("Missing source owner");
  const originalRead = owned.backend.readStream.bind(owned.backend);
  // Hold the stream after the first 1 MiB chunk for longer than the stall window.
  owned.backend.readStream = (filePath, revision, consume, context) =>
    originalRead(
      filePath,
      revision,
      async (bytes) => {
        await consume(bytes);
        await new Promise((resolve) => setTimeout(resolve, TRANSFER_STALL_MS + 2000));
      },
      context,
    );
  try {
    await writeFile(remote, Buffer.alloc(3 * 1024 * 1024, 7));
    await writeFile(local, "old destination");
    const failure = operate(
      "copy",
      { path: source, target: local },
      { cwd: fixture.root },
      sshTransferPolicy,
    );
    await expect(failure).rejects.toMatchObject({
      code: "TRANSFER_STALLED",
      effect: "not-applied",
      transferredBytes: 1024 * 1024,
      totalBytes: 3 * 1024 * 1024,
    });
    await expect(failure).rejects.toThrow(
      /no data moved for 30 s; wrote 1048576 of 3145728 bytes/u,
    );
    expect(await readFile(local, "utf8")).toBe("old destination");
  } finally {
    owned.backend.readStream = originalRead;
    await fixture.stop();
  }
}, 90000);

test.each(
  (["copy", "move"] as const).flatMap((operation) =>
    (["upload", "download", "targets", "same-target"] as const).map((route) => ({
      operation,
      route,
    })),
  ),
)(
  "regular $operation replaces destinations through $route without an overwrite flag",
  async ({ operation, route }) => {
    const fixture = await startSshFixture();
    const registry = new SshBackendRegistry(
      ["left", "right"].map((id) => ({
        id,
        host: "fixture",
        workspace: fixture.workspace,
        configFile: fixture.config,
      })),
    );
    const operate = createSshFileOperationResolver(registry);
    const local = path.join(fixture.root, "local.bin");
    const remote = path.join(fixture.workspace, "remote.bin");
    const other = path.join(fixture.workspace, "other.bin");
    const left = remoteLocation("left", remote).source;
    const target = remoteLocation(route === "targets" ? "right" : "left", other).source;
    const [source, destination, actualSource, actualTarget] =
      route === "upload"
        ? [local, left, local, remote]
        : route === "download"
          ? [left, local, remote, local]
          : [left, target, remote, other];
    const bytes = Buffer.from([0, 255, 239, 187, 191, 13, 10]);
    try {
      await writeFile(actualSource, bytes);
      await writeFile(actualTarget, "old destination");
      expect(
        await operate(
          operation,
          { path: source, target: destination },
          { cwd: fixture.root },
          sshTransferPolicy,
        ),
      ).toMatchObject({ ok: true, effect: "applied" });
      expect(await readFile(actualTarget)).toEqual(bytes);
      if (operation === "move")
        await expect(readFile(actualSource)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(actualSource)).toEqual(bytes);
    } finally {
      await fixture.stop();
    }
  },
  90000,
);

test("regular SSH transfers reject aliases and destination links before effects", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry(
    ["left", "right"].map((id) => ({
      id,
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    })),
  );
  const operate = createSshFileOperationResolver(registry);
  const remote = path.join(fixture.workspace, "remote.bin");
  const source = remoteLocation("left", remote).source;
  const bytes = Buffer.from([0, 255, 10]);
  try {
    await writeFile(remote, bytes);
    for (const target of [source, remoteLocation("right", remote).source])
      await expect(
        operate("copy", { path: source, target }, { cwd: fixture.root }, sshTransferPolicy),
      ).rejects.toMatchObject({ code: "SAME_FILE", effect: "not-applied" });
    const link = path.join(fixture.workspace, "link.bin");
    await symlink(remote, link);
    await expect(
      operate(
        "copy",
        { path: source, target: remoteLocation("left", link).source },
        { cwd: fixture.root },
        sshTransferPolicy,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILE_TYPE", effect: "not-applied" });
    expect(await readFile(remote)).toEqual(bytes);
  } finally {
    await fixture.stop();
  }
}, 90000);
function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("mixed transfers create missing parents on the destination owner", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry(
    ["left", "right"].map((id) => ({
      id,
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    })),
  );
  const resolver = createSshFileOperationResolver(registry);
  const operate: typeof resolver = (operation, input, context) =>
    resolver(operation, input, context, sshTransferPolicy);
  const local = path.join(fixture.root, "source.bin");
  const uploaded = path.join(fixture.workspace, "upload-new", "nested", "bytes.bin");
  const crossed = path.join(fixture.workspace, "cross-new", "nested", "bytes.bin");
  const downloaded = path.join(fixture.root, "download-new", "nested", "bytes.bin");
  const bytes = Buffer.from([0, 255, 13, 10]);
  try {
    await writeFile(local, bytes);
    const upload = remoteLocation("left", uploaded).source;
    const cross = remoteLocation("right", crossed).source;
    for (const [source, target, actual] of [
      [local, upload, uploaded],
      [upload, cross, crossed],
      [cross, downloaded, downloaded],
    ] as const) {
      const result = await operate(
        "copy",
        { path: source, target },
        { cwd: fixture.root },
        sshTransferPolicy,
      );
      expect(result).toMatchObject({ ok: true, effect: "applied" });
      expect((await readFile(actual)).equals(bytes)).toBe(true);
    }
  } finally {
    await fixture.stop();
  }
});
test("whole-file owners stream binary files across all backend boundaries", async () => {
  const fixture = await startSshFixture();
  const local = path.join(fixture.root, "local");
  await mkdir(local);
  const registry = new SshBackendRegistry(
    ["left", "right"].map((id) => ({
      id,
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    })),
  );
  const resolver = createSshFileOperationResolver(registry);
  const operate: typeof resolver = (operation, input, context) =>
    resolver(operation, input, context, sshTransferPolicy);
  const bytes = Buffer.alloc(33 * 1024 * 1024, 255);
  bytes.set([0, 239, 187, 191, 13, 10]);
  const cases = [
    {
      name: "upload",
      operation: "copy",
      source: path.join(local, "upload.bin"),
      target: remoteLocation("left", path.join(fixture.workspace, "uploaded.bin")).source,
      actualSource: path.join(local, "upload.bin"),
      actualTarget: path.join(fixture.workspace, "uploaded.bin"),
    },
    {
      name: "download",
      operation: "move",
      source: remoteLocation("left", path.join(fixture.workspace, "download.bin")).source,
      target: path.join(local, "downloaded.bin"),
      actualSource: path.join(fixture.workspace, "download.bin"),
      actualTarget: path.join(local, "downloaded.bin"),
    },
    {
      name: "targets",
      operation: "copy",
      source: remoteLocation("left", path.join(fixture.workspace, "left.bin")).source,
      target: remoteLocation("right", path.join(fixture.workspace, "right.bin")).source,
      actualSource: path.join(fixture.workspace, "left.bin"),
      actualTarget: path.join(fixture.workspace, "right.bin"),
    },
  ] as const;
  try {
    for (const entry of cases) {
      await writeFile(entry.actualSource, bytes);
      const result = await operate(
        entry.operation,
        { path: entry.source, target: entry.target },
        { cwd: local },
      );
      expect(result, entry.name).toMatchObject({
        ok: true,
        effect: "applied",
        path: entry.source,
        target: entry.target,
      });
      expect(checksum(await readFile(entry.actualTarget)), entry.name).toBe(checksum(bytes));
      if (entry.operation === "move")
        await expect(readFile(entry.actualSource)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(checksum(await readFile(entry.actualSource)), entry.name).toBe(checksum(bytes));
    }
    expect((await readdir(local)).some((name) => name.startsWith(".pi-ide-transfer-"))).toBe(false);
    expect(
      (await readdir(fixture.workspace)).some((name) => name.startsWith(".pi-ide-transfer-")),
    ).toBe(false);
  } finally {
    await rm(local, { recursive: true, force: true });
    await fixture.stop();
  }
}, 180000);

test("a transfer whose SSH connection is lost removes its staging file on the target", async () => {
  const fixture = await startSshFixture();
  const { target } = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const destination = path.join(fixture.workspace, "target.bin");
  const staged = async () =>
    (await readdir(fixture.workspace)).filter((name) => name.startsWith(".pi-ide-transfer-"));
  try {
    const channel = await startSshProcess(
      target,
      remotePython(await sshTransferProgram(targetOs(target))),
      [JSON.stringify({ destination, size: 3 * 1024 * 1024, mode: 0o644, expected: null })],
      neutralDirectory(target),
      { gracefulStop: true },
    );
    channel.stdout.resume();
    channel.stderr.resume();
    await channel.write(Buffer.alloc(1024 * 1024, 7));
    expect(await staged()).toHaveLength(1);
    // Kill only the local SSH client while the target still waits for bytes.
    (channel as unknown as { readonly child: ChildProcess }).child.kill("SIGKILL");
    await expect(channel.completion).rejects.toBeInstanceOf(Error);
    await expect.poll(staged, { timeout: 10_000 }).toEqual([]);
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.stop();
  }
}, 60000);