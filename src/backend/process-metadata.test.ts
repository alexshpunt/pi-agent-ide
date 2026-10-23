import { expect, test, vi } from "vitest";
import { SshBackendRegistry } from "./registry.js";
import { findSshProcessMetadata } from "./process-metadata.js";

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
        findSshProcessMetadata(registry, "ssh://fixture/tmp", 456),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
    const signal = AbortSignal.abort();
    await expect(
      findSshProcessMetadata(registry, "ssh://fixture/tmp", 123, signal),
    ).rejects.toThrow(/aborted/iu);
    expect(execute).toHaveBeenCalledTimes(3);
  } finally {
    execute.mockRestore();
  }
});
