import { expect, test, vi } from "vitest";
import { SshBackend } from "./ssh.js";
import { sshProjectExecutableAvailability } from "./process-environment.js";

test("executable discovery sends one owned candidate set without returning environment values", async () => {
  const backend = new SshBackend({ id: "fixture", host: "fixture", workspace: "/workspace" });
  const execute = vi.spyOn(backend, "execute").mockResolvedValue({
    stdout: Buffer.from("[true,false]"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  });
  expect(
    await sshProjectExecutableAvailability(backend, "/workspace", [
      { command: ["{project}/.venv/bin/server"] },
      { command: ["missing"], env: { PATH: "/custom/bin" } },
    ]),
  ).toEqual([true, false]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[1][2]).toBe(
    JSON.stringify([
      { command: "/workspace/.venv/bin/server" },
      { command: "missing", path: "/custom/bin" },
    ]),
  );
  execute.mockResolvedValueOnce({
    stdout: Buffer.from("[true]"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  });
  await expect(
    sshProjectExecutableAvailability(backend, "/workspace", [
      { command: ["first"] },
      { command: ["second"] },
    ]),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
