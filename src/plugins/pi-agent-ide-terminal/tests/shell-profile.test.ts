import { describe, expect, test } from "vitest";

import {
  resolveShellProfile,
  shellSyntaxGuidance,
} from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";

describe("terminal shell profile", () => {
  test("uses the configured Unix shell and describes its syntax", () => {
    const profile = resolveShellProfile("linux", { SHELL: "/custom/bin/bash" });

    expect(profile).toMatchObject({
      executable: "/custom/bin/bash",
      displayName: "Bash",
      family: "posix",
    });
    expect(profile.commandArgs("printf ok")).toEqual(["-c", "printf ok"]);
    expect(shellSyntaxGuidance(profile)).toContain("Bash syntax");
  });

  test("uses PowerShell on Windows unless the user configured another shell", () => {
    const profile = resolveShellProfile("win32", {});

    expect(profile).toMatchObject({
      executable: "powershell.exe",
      displayName: "Windows PowerShell",
      family: "powershell",
    });
    expect(profile.commandArgs("Write-Output ok")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Write-Output ok",
    ]);
  });

  test("honors a configured Windows command shell", () => {
    const profile = resolveShellProfile("win32", { SHELL: "C:\\Windows\\System32\\cmd.exe" });

    expect(profile.family).toBe("cmd");
    expect(profile.commandArgs("echo ok")).toEqual(["/d", "/s", "/c", "echo ok"]);
  });
});
