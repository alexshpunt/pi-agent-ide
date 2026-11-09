import type {
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import { SshBackendRegistry } from "#src/backend/registry.ts";
import type { SshTarget } from "#src/backend/ssh.ts";
import {
  remoteShellProfile,
  resolveShellProfile,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.ts";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.ts";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.ts";

const windowsTarget: SshTarget = {
  id: "win",
  host: "win-alias",
  workspace: "C:/Users/dev",
  os: "windows",
};
const linuxTarget: SshTarget = { id: "box", host: "box-alias", workspace: "/home/dev" };

const started = new Error("remote start reached");

function register(platform: NodeJS.Platform, targets: readonly SshTarget[]) {
  const tools = new Map<string, ToolDefinition>();
  const hidden = new Map<string, ToolDefinition>();
  const manager = new TerminalSessionManager();
  const startRemote = vi.spyOn(manager, "startRemote").mockRejectedValue(started);
  const start = vi.spyOn(manager, "start").mockImplementation(() => {
    throw new Error("local start reached");
  });
  registerTerminalTools(
    {
      registerTool: (definition) =>
        void (definition.exposure === "hidden" ? hidden : tools).set(
          definition.name,
          definition as ToolDefinition,
        ),
    },
    manager,
    resolveShellProfile(platform, platform === "win32" ? {} : { SHELL: "/bin/bash" }),
    { bind: vi.fn(), notifyWaitTransition: vi.fn() },
    undefined,
    new SshBackendRegistry(targets),
    undefined,
    platform,
  );
  const run = (name: string, cwd: string | undefined) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered`);
    return tool.execute(
      "call",
      { command: "echo hi", ...(cwd === undefined ? {} : { cwd }) },
      undefined,
      undefined,
      { cwd: "/workspace" } as ExtensionToolContext & ExtensionContext,
    );
  };
  return { tools, hidden, startRemote, start, run };
}

describe("remote shell tool exposure", () => {
  test("a Linux host without Windows targets has only bash", () => {
    expect([...register("linux", [linuxTarget]).tools.keys()]).toEqual(["bash"]);
  });

  test("a Linux host with a Windows target adds remote_powershell", () => {
    const { tools } = register("linux", [linuxTarget, windowsTarget]);
    expect([...tools.keys()]).toEqual(["bash", "remote_powershell"]);
    const remote = tools.get("remote_powershell");
    expect(remote?.description).toContain("only on remote targets");
    expect(remote?.parameters).toMatchObject({ required: ["command", "cwd"] });
    expect(tools.get("bash")?.parameters).toMatchObject({ required: ["command"] });
  });

  test("a Windows host without Linux targets has only powershell", () => {
    expect([...register("win32", [windowsTarget]).tools.keys()]).toEqual(["powershell"]);
  });

  test("a Windows host with a Linux target adds remote_bash", () => {
    const { tools } = register("win32", [windowsTarget, linuxTarget]);
    expect([...tools.keys()]).toEqual(["powershell", "remote_bash"]);
    expect(tools.get("remote_bash")?.parameters).toMatchObject({ required: ["command", "cwd"] });
  });
});

describe("shell tool working directories", () => {
  test("the remote tool starts a session on a target of its OS", async () => {
    const { run, startRemote } = register("linux", [linuxTarget, windowsTarget]);
    await expect(run("remote_powershell", "ssh://win/C:/Users/dev/project")).rejects.toBe(started);
    const remote = startRemote.mock.calls[0]?.[0].remote;
    expect(remote?.location.source).toBe("ssh://win/C:/Users/dev/project");
    expect(remote?.backend.target.os).toBe("windows");
  });

  test("the local tool also covers targets of its own OS", async () => {
    const linux = register("linux", [linuxTarget, windowsTarget]);
    await expect(linux.run("bash", "ssh://box/home/dev")).rejects.toBe(started);
    const windows = register("win32", [linuxTarget, windowsTarget]);
    await expect(windows.run("powershell", "ssh://win/C:/Users/dev")).rejects.toBe(started);
  });

  test("the remote tool rejects a local or missing working directory", async () => {
    const { run, startRemote } = register("linux", [windowsTarget]);
    await expect(run("remote_powershell", "/tmp")).rejects.toThrow(
      /remote_powershell runs only on remote targets.*Windows target/,
    );
    await expect(run("remote_powershell", undefined)).rejects.toThrow(/runs only on remote/);
    expect(startRemote).not.toHaveBeenCalled();
  });

  test("a tool rejects a target of the other OS and names the tool that accepts it", async () => {
    const linux = register("linux", [linuxTarget, windowsTarget]);
    await expect(linux.run("bash", "ssh://win/C:/Users/dev")).rejects.toThrow(
      /Windows target.*Use remote_powershell/,
    );
    await expect(linux.run("remote_powershell", "ssh://box/home/dev")).rejects.toThrow(
      /Linux target.*Use bash/,
    );
    const windows = register("win32", [linuxTarget, windowsTarget]);
    await expect(windows.run("powershell", "ssh://box/home/dev")).rejects.toThrow(
      /Linux target.*Use remote_bash/,
    );
    await expect(windows.run("remote_bash", "ssh://win/C:/Users/dev")).rejects.toThrow(
      /Windows target.*Use powershell/,
    );
    expect(linux.startRemote).not.toHaveBeenCalled();
    expect(windows.startRemote).not.toHaveBeenCalled();
  });
});

test("the remote shell follows the target OS", () => {
  expect(remoteShellProfile("linux")).toMatchObject({ executable: "/bin/bash", family: "posix" });
  const powershell = remoteShellProfile("windows");
  expect(powershell).toMatchObject({ executable: "powershell.exe", family: "powershell" });
  expect(powershell.commandArgs("Get-Date")).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Get-Date",
  ]);
});
