import os from "node:os";
import path from "node:path";

import type { ShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

/** Resolve the shell configured for the current user and describe its command syntax. */
export function resolveShellProfile(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellProfile {
  if (platform === "win32") {
    const executable = environment.SHELL?.trim() || "powershell.exe";
    const basename = path.win32.basename(executable).toLowerCase();
    if (basename === "cmd" || basename === "cmd.exe") {
      return {
        executable,
        displayName: "Command Prompt",
        family: "cmd",
        commandArgs: (command) => ["/d", "/s", "/c", command],
      };
    }
    return {
      executable,
      displayName: basename.startsWith("pwsh") ? "PowerShell" : "Windows PowerShell",
      family: "powershell",
      commandArgs: (command) => ["-NoLogo", "-NoProfile", "-Command", command],
    };
  }

  const executable =
    environment.SHELL?.trim() ||
    os.userInfo().shell ||
    (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const basename = path.basename(executable);
  return {
    executable,
    displayName: basename === "zsh" ? "zsh" : basename === "bash" ? "Bash" : basename,
    family: "posix",
    commandArgs: (command) => ["-c", command],
  };
}

/** Return concise syntax guidance for the shell exposed to the agent. */
export function shellSyntaxGuidance(profile: ShellProfile): string {
  switch (profile.family) {
    case "powershell": {
      return "Write PowerShell syntax. Use PowerShell cmdlets, `$env:NAME` for environment variables, and `;` or pipelines to compose commands.";
    }
    case "cmd": {
      return "Write Command Prompt syntax. Use `%NAME%` for environment variables and `&&` to chain successful commands.";
    }
    case "posix": {
      return `Write ${profile.displayName} syntax. Use POSIX-style paths, \`$NAME\` for environment variables, and \`&&\` or pipelines to compose commands.`;
    }
  }
}
