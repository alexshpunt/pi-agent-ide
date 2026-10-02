import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";

describe("terminal command guidance", () => {
  test.each([
    ["win32", {}, "Windows PowerShell", "powershell.exe", "Write PowerShell syntax", "$env:NAME"],
    [
      "win32",
      { SHELL: "pwsh.exe" },
      "PowerShell",
      "pwsh.exe",
      "Write PowerShell syntax",
      "$env:NAME",
    ],
    [
      "win32",
      { SHELL: "cmd.exe" },
      "Command Prompt",
      "cmd.exe",
      "Write Command Prompt syntax",
      "%NAME%",
    ],
    ["linux", { SHELL: "/bin/bash" }, "Bash", "/bin/bash", "Write Bash syntax", "$NAME"],
  ] as const)(
    "identifies %s shell %j in the command schema",
    (platform, environment, name, executable, syntax, variable) => {
      let tool: { schema: string; description: string; promptSnippet?: string } | undefined;
      const registerTool: ExtensionAPI["registerTool"] = (definition) => {
        tool = {
          schema: JSON.stringify(definition.parameters),
          description: definition.description,
          promptSnippet: definition.promptSnippet,
        };
      };
      const profile = resolveShellProfile(platform, environment);
      registerTerminalTools({ registerTool }, {} as TerminalSessionManager, profile, {
        bind: vi.fn(),
        notifyWaitTransition: vi.fn(),
      });

      if (!tool) throw new Error("Terminal tool was not registered");
      const guidance = tool.schema;
      expect(guidance).toContain(name);
      expect(guidance).toContain(executable);
      expect(guidance).toContain(syntax);
      expect(guidance).toContain(variable);
      expect(tool.description).toContain(executable);
      expect(tool.promptSnippet).toContain(name);
    },
  );
});
