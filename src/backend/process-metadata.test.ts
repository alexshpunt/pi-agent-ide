import { expect, test, vi } from "vitest";
import { SshBackendRegistry } from "./registry.js";
import { readSshProcessMetadata } from "./process-metadata.js";
import { createSshProcessOwner } from "./vision-registration.js";

test("selected process errors retain their exact resource instead of the owner root", async () => {
  const registry = new SshBackendRegistry([{ id: "fixture", host: "fixture", workspace: "/tmp" }]);
  const owner = registry.resolve("ssh://fixture/tmp");
  if (!owner) throw new Error("Missing owner");
  const execute = vi.spyOn(owner.backend, "execute").mockResolvedValue({
    exitCode: 0,
    stdout: Buffer.from(JSON.stringify({ error: "ENOENT" })),
    stderr: Buffer.alloc(0),
  });
  try {
    const access = createSshProcessOwner(registry);
    await expect(access.read("process:ssh://fixture/456")).rejects.toMatchObject({
      code: "ENOENT",
      effect: "not-applied",
      message: "ENOENT: process:ssh://fixture/456",
    });
    await expect(access.read("process:ssh://unknown/456")).rejects.toMatchObject({
      code: "UNKNOWN_TARGET",
      effect: "not-applied",
      message: "UNKNOWN_TARGET: process:ssh://unknown/456",
    });
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    execute.mockRestore();
  }
});
const row = {
  pid: 123,
  parentPid: 1,
  command: "owned child",
  started: "2026-01-01T00:00:00Z",
  identity: "abc-123:42",
  executable: "/usr/bin/python3",
};

test("a selected PID cannot accept another process or a malformed owner reply", async () => {
  const registry = new SshBackendRegistry([{ id: "fixture", host: "fixture", workspace: "/tmp" }]);
  const owner = registry.resolve("ssh://fixture/tmp");
  if (!owner) throw new Error("Missing owner");
  const execute = vi.spyOn(owner.backend, "execute");
  try {
    for (const reply of [
      JSON.stringify({ processes: [row] }),
      JSON.stringify({ processes: [row, row] }),
      "not JSON",
    ]) {
      execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: Buffer.from(reply),
        stderr: Buffer.alloc(0),
      });
      await expect(
        readSshProcessMetadata(registry, "ssh://fixture/tmp", 456),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
    const signal = AbortSignal.abort();
    await expect(
      readSshProcessMetadata(registry, "ssh://fixture/tmp", 123, signal),
    ).rejects.toThrow(/aborted/iu);
    expect(execute).toHaveBeenCalledTimes(3);
  } finally {
    execute.mockRestore();
  }
});
