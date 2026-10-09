import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { SshBackendRegistry } from "./registry.js";
import * as dap from "./dap-transport.js";
import { prepareSshNodeDebugger } from "./dap-node-transport.js";

function transport(pid: number): dap.SshDapTransport {
  const readable = new PassThrough();
  const writable = new PassThrough();
  let finish: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    readable,
    writable,
    completion,
    remote: { target: "fixture", pid, identity: `boot:${pid}` },
    stop: vi.fn(() => {
      readable.destroy();
      writable.destroy();
      finish?.();
      return Promise.resolve();
    }),
  };
}

test("Node shutdown waits for a reverse connection already starting and does not return its client", async () => {
  const registry = new SshBackendRegistry([{ id: "fixture", host: "fixture", workspace: "/tmp" }]);
  const backend = registry.resolve("ssh://fixture/tmp")?.backend;
  if (!backend) throw new Error("Missing owner");
  const execute = vi.spyOn(backend, "execute").mockResolvedValue({
    exitCode: 0,
    stdout: Buffer.from("/tmp/pi-agent-ide-node-owned\n"),
    stderr: Buffer.alloc(0),
  });
  const server = transport(10);
  const primary = transport(11);
  const child = transport(12);
  let release: ((value: dap.SshDapTransport) => void) | undefined;
  const starting = new Promise<dap.SshDapTransport>((resolve) => {
    release = resolve;
  });
  const start = vi
    .spyOn(dap, "startSshDapTransport")
    .mockResolvedValueOnce(server)
    .mockResolvedValueOnce(primary)
    .mockReturnValueOnce(starting);
  let stopped: Promise<void> | undefined;
  try {
    const owned = await prepareSshNodeDebugger(registry, "ssh://fixture/tmp", {});
    if (!owned.connectChild) throw new Error("Missing reverse connection");
    const connected = owned.connectChild().then(
      (client) => ({ client }),
      (error: unknown) => ({ error }),
    );
    let finished = false;
    stopped = owned.client.dispose().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(finished).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release?.(child);
    }
    expect(await connected).toMatchObject({ error: { code: "SESSION_CLOSED" } });
    await stopped;
    expect(child.stop).toHaveBeenCalledOnce();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(primary.stop).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    release?.(child);
    await stopped;
    start.mockRestore();
    execute.mockRestore();
    await Promise.all([server.stop(), primary.stop(), child.stop()]);
  }
});

test("Node shutdown does not remove its directory while another connection is still stopping", async () => {
  const registry = new SshBackendRegistry([{ id: "fixture", host: "fixture", workspace: "/tmp" }]);
  const backend = registry.resolve("ssh://fixture/tmp")?.backend;
  if (!backend) throw new Error("Missing owner");
  const execute = vi.spyOn(backend, "execute").mockResolvedValue({
    exitCode: 0,
    stdout: Buffer.from("/tmp/pi-agent-ide-node-owned\n"),
    stderr: Buffer.alloc(0),
  });
  const server = transport(10);
  const primary = transport(11);
  const child = transport(12);
  const failure = new Error("Primary connection stop failed");
  vi.spyOn(primary, "stop").mockRejectedValue(failure);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finishChild = vi.mocked(child.stop).getMockImplementation();
  if (!finishChild) throw new Error("Missing owned transport stop");
  vi.spyOn(child, "stop").mockImplementation(async () => {
    await delayed;
    await finishChild();
  });
  const start = vi
    .spyOn(dap, "startSshDapTransport")
    .mockResolvedValueOnce(server)
    .mockResolvedValueOnce(primary)
    .mockResolvedValueOnce(child);
  let stopped: Promise<unknown> | undefined;
  try {
    const owned = await prepareSshNodeDebugger(registry, "ssh://fixture/tmp", {});
    if (!owned.connectChild) throw new Error("Missing reverse connection");
    await owned.connectChild();
    stopped = owned.client.dispose().then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(server.stop).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
    }
    expect(await stopped).toBe(failure);
    expect(server.stop).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    release?.();
    await stopped;
    start.mockRestore();
    execute.mockRestore();
    await Promise.all([server.stop(), finishChild()]);
    primary.readable.destroy();
    primary.writable.destroy();
  }
});
