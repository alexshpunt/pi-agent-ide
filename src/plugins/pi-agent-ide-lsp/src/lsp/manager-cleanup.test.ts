import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { LspManager } from "./manager.js";
import { LspServerRegistry } from "./registry.js";

afterEach(async () => {
  await LspManager.resetForTest();
  vi.restoreAllMocks();
});

test.each(["shutdownAll", "dispose"] as const)(
  "%s waits for every owned cleanup and reports failed stops",
  async (method) => {
    vi.spyOn(LspClient.prototype, "start").mockResolvedValue();
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("Owned server stop failed");
    let failedOnce = false;
    vi.spyOn(LspClient.prototype, "shutdown").mockImplementation(function (this: LspClient) {
      if (this.serverId === "failed" && !failedOnce) {
        failedOnce = true;
        return Promise.reject(failure);
      }
      return delayed;
    });
    const manager = LspManager.init(
      LspServerRegistry.fromConfig(
        {
          version: 1,
          servers: {
            failed: {
              command: ["owned"],
              rootMarkers: [],
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: [],
            },
            delayed: {
              command: ["owned"],
              rootMarkers: [],
              languages: { python: { extensions: [".py"] } },
              capabilities: [],
            },
          },
        },
        "/workspace",
      ),
    );
    await manager.getOrStart(".ts", "/workspace", "symbols");
    await manager.getOrStart(".py", "/workspace", "symbols");
    expect(manager.clientCount).toBe(2);
    let finished = false;
    const shutdown = Promise.resolve(manager[method]());
    const observed = shutdown.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release?.();
      await expect(shutdown).rejects.toMatchObject({ name: "AggregateError", errors: [failure] });
      expect(manager.clientCount).toBe(0);
    } finally {
      release?.();
      await observed;
    }
  },
);
