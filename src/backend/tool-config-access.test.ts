import { afterEach, expect, test, vi } from "vitest";
import { SshBackendRegistry } from "./registry.js";
import { SshBackend } from "./ssh.js";
import { createSshToolConfigAccess } from "./tool-config-access.js";

afterEach(() => vi.restoreAllMocks());

test("owned configuration callbacks forward their invocation signal", async () => {
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: "/workspace" },
  ]);
  const access = createSshToolConfigAccess(registry);
  const failure = new Error("Stop before owner I/O");
  const execute = vi.spyOn(SshBackend.prototype, "execute").mockRejectedValue(failure);
  const read = vi.spyOn(SshBackend.prototype, "read").mockRejectedValue(failure);
  const controller = new AbortController();
  await expect(
    access.paths("ssh://fixture/workspace", "lsp-servers", controller.signal),
  ).rejects.toBe(failure);
  expect(execute.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
  await expect(
    access.readText("ssh://fixture/workspace/config.json", controller.signal),
  ).rejects.toBe(failure);
  expect(read.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});
