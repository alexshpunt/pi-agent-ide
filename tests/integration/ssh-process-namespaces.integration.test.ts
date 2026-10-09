import { access } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshPidNamespaceFixture } from "#integration/support/ssh-pid-namespace-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";

test("the same native PID on two SSH targets never becomes a controller process or the other target", async () => {
  const left = await startSshPidNamespaceFixture();
  console.info({
    stage: "left ready",
    root: left.root,
    serverPid: left.serverPid,
    controllerPid: left.controllerPid,
  });
  let right: Awaited<ReturnType<typeof startSshPidNamespaceFixture>> | undefined;
  try {
    right = await startSshPidNamespaceFixture();
    console.info({
      stage: "right ready",
      root: right.root,
      serverPid: right.serverPid,
      controllerPid: right.controllerPid,
    });
    expect(left.namespace).not.toBe(right.namespace);
    const targets = [left, right].map((fixture, index) => ({
      id: index === 0 ? "left" : "right",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    }));
    const registry = new SshBackendRegistry(targets);
    const snapshots = [];
    for (const target of targets) {
      const scope = `ssh://${target.id}${target.workspace}`;
      const [snapshot] = await readSshProcessMetadata(registry, scope, 1);
      expect(snapshot).toMatchObject({
        pid: 1,
        parentPid: 0,
        host: "ssh",
        target: target.id,
        owned: false,
        resource: `process:ssh://${target.id}/1`,
      });
      expect(snapshot?.command).toContain("ssh-network-server.py");
      expect(snapshot?.identity).toMatch(/^[a-f0-9-]+:\d+$/u);
      snapshots.push(snapshot);
      const owner = registry.resolve(scope);
      if (!owner) throw new Error("No namespace owner");
      const native = await owner.backend.execute(
        "readlink",
        ["/proc/self/ns/pid"],
        target.workspace,
      );
      expect(native.exitCode).toBe(0);
      expect(native.stdout.toString("utf8").trim()).toBe(
        target.id === "left" ? left.namespace : right.namespace,
      );
    }
    expect(snapshots[0]?.identity).not.toBe(snapshots[1]?.identity);
    console.info({ stage: "both native snapshots", snapshots });
    await left.stop();
    console.info({ stage: "left stopped" });
    await expect(access(left.root)).rejects.toMatchObject({ code: "ENOENT" });
    for (const pid of [left.serverPid, left.controllerPid, left.controllerSshdPid])
      await expect(access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readSshProcessMetadata(registry, `ssh://left${left.workspace}`, 1, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "TRANSPORT_FAILED" });
    const [retained] = await readSshProcessMetadata(registry, `ssh://right${right.workspace}`, 1);
    expect(retained).toEqual(snapshots[1]);
    await expect(
      readSshProcessMetadata(registry, "ssh://unconfigured/tmp", 1),
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  } finally {
    await left.stop();
    await right?.stop();
  }
  await expect(access(right.root)).rejects.toMatchObject({ code: "ENOENT" });
  for (const pid of [right.serverPid, right.controllerPid, right.controllerSshdPid])
    await expect(access(`/proc/${pid}`)).rejects.toMatchObject({ code: "ENOENT" });
}, 30000);
