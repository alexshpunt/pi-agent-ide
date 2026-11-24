import { expect, test, vi } from "vitest";
import { SshBackend } from "./ssh.ts";
import { sshProjectEnvironment, sshProjectExecutableAvailability } from "./process-environment.ts";

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
  expect(execute.mock.calls[0]?.[1][0]).toBe(
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

test("Windows discovery passes native project paths and case-insensitive executable overrides", async () => {
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: "D:/Workspace",
    os: "windows",
  });
  const execute = vi.spyOn(backend, "execute").mockResolvedValue({
    stdout: Buffer.from("[true]"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  });
  expect(
    await sshProjectExecutableAvailability(backend, backend.target.workspace, [
      { command: ["{project}\\worker"], env: { Path: "D:\\Tools", Pathext: ".CMD;.EXE" } },
    ]),
  ).toEqual([true]);
  expect(execute.mock.calls[0]?.[1]).toEqual([
    JSON.stringify([{ command: "D:\\Workspace\\worker", path: "D:\\Tools", pathExt: ".CMD;.EXE" }]),
    JSON.stringify([
      "D:\\Workspace\\node_modules\\.bin",
      "D:\\Workspace\\.venv\\Scripts",
      "D:\\Workspace\\venv\\Scripts",
      "D:\\Workspace\\vendor\\bin",
    ]),
  ]);
});

test("prepends Windows native project executable directories to the configured Path", async () => {
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: "D:/Workspace With Spaces",
    os: "windows",
  });
  vi.spyOn(backend, "execute").mockResolvedValue({
    stdout: Buffer.from("C:\\System"),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  });
  expect(
    await sshProjectEnvironment(backend, backend.target.workspace, {
      Path: "D:\\Tools",
      OTHER: "kept",
    }),
  ).toEqual({
    PATH: [
      "D:\\Workspace With Spaces\\node_modules\\.bin",
      "D:\\Workspace With Spaces\\.venv\\Scripts",
      "D:\\Workspace With Spaces\\venv\\Scripts",
      "D:\\Workspace With Spaces\\vendor\\bin",
      "D:\\Tools",
    ].join(";"),
    OTHER: "kept",
  });
});
