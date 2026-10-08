import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { SshBackendError } from "#src/backend/ssh.js";
import { findSshProcessMetadata, readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { stopOwnedSshProcess } from "#src/backend/owned-process-stop.js";

test("lost-stop reconciliation never treats a living PID or failed native inspection as confirmed cleanup", async () => {
  const fixture = await startSshFixture();
  const target = {
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  };
  const registry = new SshBackendRegistry([target]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const backend = registry.resolve(scope)?.backend;
  if (!backend) throw new Error("Missing native owner");
  const native = await backend.startProcess(
    "python3",
    ["-c", "import time;time.sleep(60)"],
    fixture.workspace,
  );
  native.stdout.resume();
  native.stderr.resume();
  const lost = new SshBackendError("TRANSPORT_FAILED", scope, "unknown");
  const channel = { pid: native.pid, identity: native.identity, stop: () => Promise.reject(lost) };
  try {
    if (!native.identity) throw new Error("Missing native identity");
    await expect(stopOwnedSshProcess(channel, registry, scope)).rejects.toBe(lost);
    expect((await readSshProcessMetadata(registry, scope, native.pid))[0]?.identity).toBe(
      native.identity,
    );
    const unknown = new SshBackendRegistry([]);
    await expect(
      stopOwnedSshProcess({ ...channel, identity: undefined }, unknown, scope),
    ).rejects.toBe(lost);
    const missingCwd = `${scope}/absent-project`;
    await expect(findSshProcessMetadata(registry, missingCwd, native.pid)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stopOwnedSshProcess(channel, registry, missingCwd)).rejects.toMatchObject({
      name: "AggregateError",
      errors: [lost, expect.objectContaining({ code: "ENOENT" })],
    });
    // A different recorded start identity proves only that the old owner is gone, not control of this PID.
    const replaced = { ...channel, identity: `${native.identity.split(":")[0]}:0` };
    await expect(stopOwnedSshProcess(replaced, registry, scope)).resolves.toBeUndefined();
    expect((await readSshProcessMetadata(registry, scope, native.pid))[0]?.identity).toBe(
      native.identity,
    );
    await native.stop();
    await expect(findSshProcessMetadata(registry, scope, native.pid)).resolves.toBeUndefined();
    await expect(stopOwnedSshProcess(channel, registry, scope)).resolves.toBeUndefined();
  } finally {
    try {
      await native.stop();
    } finally {
      await fixture.stop();
    }
  }
}, 30000);
