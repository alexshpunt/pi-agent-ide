import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";
import type { LspWorkspaceOwner } from "./workspace-owner.js";

function registry(root: string) {
  return LspServerRegistry.fromConfig(
    {
      version: 1,
      servers: {
        owned: {
          command: ["owned-server"],
          rootMarkers: [],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
      },
    },
    root,
  );
}

function owner(): LspWorkspaceOwner {
  const unused = () => {
    throw new Error("Unexpected owner operation");
  };
  return {
    transport: unused,
    readText: unused,
    readSnapshot: unused,
    readBytes: unused,
    exists: unused,
    isFile: vi.fn(() => Promise.resolve(false)),
    entries: unused,
  };
}

test.each([false, true])(
  "disposing pending startup reports failed cleanup (failed=%s)",
  async (failed) => {
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(LspClient.prototype, "start").mockImplementation((signal?: AbortSignal) => {
      entered?.();
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const failure = new Error("Pending owned stop failed");
    const stop = vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue();
    if (failed) stop.mockRejectedValueOnce(failure);
    const manager = LspManager.init(registry("/workspace"));
    const pending = manager.getOrStart(".ts", "/workspace", "symbols");
    const observed = pending.catch((error: unknown) => error);
    await started;
    const shutdown = manager.dispose();
    if (failed) {
      const report = await shutdown.catch((error: unknown) => error);
      expect(report).toBeInstanceOf(AggregateError);
      const leaves = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
      expect(leaves(report)).toContain(failure);
    } else {
      await expect(shutdown).resolves.toBeUndefined();
    }
    await observed;
  },
);

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
});

test("cancelled workspace discovery interrupts its owned directory read", async () => {
  const root = "ssh://fixture/workspace";
  const access = owner();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const entries = vi.fn(
    (_source: string, signal?: AbortSignal) =>
      new Promise<readonly { name: string; kind: "file" }[]>((resolve, reject) => {
        release = () => resolve([]);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered?.();
      }),
  );
  access.entries = entries;
  const manager = LspManager.init(registry(root), access);
  const controller = new AbortController();
  const pending = manager.prepareWorkspaceSymbols(root, root, () => true, controller.signal);
  const outcome = pending.then(
    () => "completed",
    () => "cancelled",
  );
  try {
    await started;
    expect(entries.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort(new Error("Cancel owned discovery"));
    await expect(pending).rejects.toThrow("Cancel owned discovery");
  } finally {
    release?.();
    await outcome;
  }
});

test("pre-cancelled discovery starts no owner I/O", async () => {
  const root = "ssh://fixture/workspace";
  const access = owner();
  const manager = LspManager.init(registry(root), access);
  const controller = new AbortController();
  controller.abort(new Error("Do not discover"));
  await expect(
    manager.prepareWorkspaceSymbols(root, root, () => true, controller.signal),
  ).rejects.toThrow("Do not discover");
  expect(access.isFile).not.toHaveBeenCalled();
});

test("cancelling one startup waiter keeps the shared server for its other waiter", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let startupSignal: AbortSignal | undefined;
  const start = vi
    .spyOn(LspClient.prototype, "start")
    .mockImplementation((signal?: AbortSignal) => {
      startupSignal = signal;
      entered?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  const stop = vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue();
  const manager = LspManager.init(registry("/workspace"));
  const controller = new AbortController();
  const cancelled = manager.getOrStart(".ts", "/workspace", "symbols", controller.signal);
  const cancelledOutcome = cancelled.then(
    () => "completed",
    (error: unknown) => error,
  );
  const retained = manager.getOrStart(".ts", "/workspace", "symbols");
  const failure = new Error("Cancel only my wait");
  try {
    await started;
    controller.abort(failure);
    const outcome = await Promise.race([cancelledOutcome, nextTurn().then(() => "pending")]);
    expect(outcome).toBe(failure);
    expect(startupSignal?.aborted).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    release?.();
    expect(await retained).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await Promise.allSettled([cancelled, retained]);
  }
});
