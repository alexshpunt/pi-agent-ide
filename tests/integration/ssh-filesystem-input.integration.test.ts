import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";
import { remoteLocation } from "#src/backend/identity.js";

function checksum(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("owned filesystem stdin and replies preserve the full binary limit outside a missing workspace", async () => {
  const fixture = await startSshFixture();
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: `${fixture.root}/missing-workspace`,
    configFile: fixture.config,
  });
  const file = `${fixture.workspace}/outside/nested café #/bytes.bin`;
  const source = remoteLocation("fixture", file).source;
  const bytes = Buffer.alloc(32 * 1024 * 1024, 255);
  bytes.set(Buffer.from("café\0\r\n", "utf8"));
  bytes.set([0, 128, 255, 13, 10, 42], bytes.length - 6);
  try {
    const revision = await backend.write(file, bytes, null);
    const native = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import hashlib,pathlib,sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())",
        file,
      ],
      fixture.workspace,
    );
    expect(native.exitCode).toBe(0);
    expect(native.stdout.toString("utf8")).toBe(`${checksum(bytes)}\n`);
    const snapshot = await backend.read(file);
    expect(snapshot.version).toBe(revision);
    expect(snapshot.bytes.length).toBe(bytes.length);
    expect(checksum(snapshot.bytes)).toBe(checksum(bytes));
    const tail = await backend.readRange(file, -6, 4);
    expect(tail).toMatchObject({ offset: bytes.length - 6, totalBytes: bytes.length });
    expect(tail.bytes).toEqual(Buffer.from([0, 128, 255, 13]));
    await expect(
      backend.write(file, Buffer.alloc(bytes.length + 1), revision),
    ).rejects.toMatchObject({
      code: "CONTENT_LIMIT",
      effect: "not-applied",
      source,
    });
    expect((await backend.read(file)).version).toBe(revision);
    await expect(backend.stat(`${fixture.root}/missing-workspace`)).rejects.toMatchObject({
      code: "ENOENT",
      effect: "not-applied",
    });
  } finally {
    await fixture.stop();
  }
}, 60000);

test("owned read errors retain the selected source and never imply a user-file write", async () => {
  const fixture = await startSshFixture();
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const file = `${fixture.workspace}/too-large.bin`;
  try {
    const created = await backend.execute(
      "/usr/bin/python3",
      [
        "-c",
        "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.touch(); p.open('r+b').truncate(32*1024*1024+1)",
        file,
      ],
      fixture.workspace,
    );
    expect(created.exitCode).toBe(0);
    await expect(backend.read(file)).rejects.toMatchObject({
      code: "CONTENT_LIMIT",
      effect: "not-applied",
      source: remoteLocation("fixture", file).source,
    });
    expect(await backend.stat(file)).toMatchObject({ size: 32 * 1024 * 1024 + 1 });
    await expect(backend.read(`${file}.missing`)).rejects.toMatchObject({
      code: "ENOENT",
      effect: "not-applied",
      source: remoteLocation("fixture", `${file}.missing`).source,
    });
    const refused = `${fixture.root}/unwritable-owned-file.txt`;
    await expect(
      backend.write(refused, Buffer.from("Do not bypass native permissions"), null),
    ).rejects.toMatchObject({
      code: "EACCES",
      effect: "not-applied",
      source: remoteLocation("fixture", refused).source,
    });
    await expect(backend.stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
    const controller = new AbortController();
    const reason = new Error("Do not start my read");
    controller.abort(reason);
    await expect(backend.read(file, { signal: controller.signal })).rejects.toBe(reason);
  } finally {
    await fixture.stop();
  }
});
