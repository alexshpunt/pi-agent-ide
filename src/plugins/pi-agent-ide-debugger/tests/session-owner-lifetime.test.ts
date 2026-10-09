import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { DapClient } from "#src/plugins/pi-agent-ide-debugger/src/dap-client.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

test("an early launch refusal is reported before waiting for initialized", async () => {
  const stop = vi.fn(async () => {});
  const client = DapClient.fromTransport({
    readable: new PassThrough(),
    writable: new PassThrough(),
    completion: new Promise<void>(() => {}),
    stop,
  });
  vi.spyOn(client, "request")
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("Owned launch refused"));
  const manager = new DebugSessionManager(() => ({
    key: "owned",
    readText: async () => "label = 42\n",
    serverPath: () => "/owned/note.py",
    resourcePath: () => "ssh://owned/owned/note.py",
    prepare: async () => ({ client, adapterID: "debugpy", request: "launch", launch: {} }),
  }));
  const session = manager.create({
    adapter: "debugpy",
    cwd: "ssh://owned/owned",
    program: "ssh://owned/owned/note.py",
    args: [],
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Startup never reported launch refusal")),
    200,
  );
  try {
    await expect(manager.start(session, controller.signal)).rejects.toThrow("Owned launch refused");
    expect(stop).toHaveBeenCalledOnce();
    expect(session.status).toBe("configured");
  } finally {
    clearTimeout(timeout);
    await manager.dispose();
  }
});

test("session delete waits for disconnect before stopping the owned transport", async () => {
  let acknowledge: (() => void) | undefined;
  const disconnect = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const stop = vi.fn(async () => {});
  const client = DapClient.fromTransport({
    readable: new PassThrough(),
    writable: new PassThrough(),
    completion: new Promise<void>(() => {}),
    stop,
  });
  vi.spyOn(client, "request").mockReturnValue(disconnect);
  const manager = new DebugSessionManager();
  const session = manager.create({
    adapter: "debugpy",
    program: "/owned/note.py",
    cwd: "/owned",
    args: [],
  });
  session.client = client;
  const cleanup = manager.delete(session.source);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();
  } finally {
    acknowledge?.();
    await cleanup;
  }
  expect(stop).toHaveBeenCalledOnce();
});
for (const operation of ["delete", "dispose"] as const) {
  test(`session ${operation} waits for its owned adapter to stop`, async () => {
    const manager = new DebugSessionManager();
    let release: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = manager.create({
      adapter: "debugpy",
      program: "/owned/note.py",
      cwd: "/owned",
      args: [],
    });
    session.client = DapClient.fromTransport({
      readable: new PassThrough(),
      writable: new PassThrough(),
      completion: new Promise<void>(() => {}),
      stop: () => stopped,
    });
    let finished = false;
    const cleanup = Promise.resolve(
      operation === "delete" ? manager.delete(session.source) : manager.dispose(),
    ).then(() => {
      finished = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    } finally {
      release?.();
      await cleanup;
    }
    expect(manager.list()).toEqual([]);
  });
}
