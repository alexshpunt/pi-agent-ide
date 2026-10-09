import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

import { formatAgentTerminalSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/output-limits.js";
import { resolveShellProfile } from "#src/plugins/pi-agent-ide-terminal/src/shell-profile.js";
import { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import { registerTerminalTools } from "#src/plugins/pi-agent-ide-terminal/src/tools.js";

test.runIf(process.platform !== "win32")(
  "releases a wait using only the manager API available before reload",
  async () => {
    const manager = new TerminalSessionManager();
    const context = { cwd: process.cwd() } as ExtensionToolContext;
    let execute: (() => Promise<unknown>) | undefined;
    const registerTool: ExtensionAPI["registerTool"] = (definition) => {
      const tool = definition as ToolDefinition;
      execute = async () =>
        tool.execute(
          "retained-manager",
          {
            command: "IFS= read -r answer; printf 'received:%s' \"$answer\"",
            timeoutSeconds: 30,
          },
          undefined,
          undefined,
          context,
        );
    };
    const notifyWaitTransition = vi.fn();
    const release = registerTerminalTools(
      { registerTool },
      manager,
      resolveShellProfile("linux", { SHELL: "/bin/bash" }),
      {
        bind: vi.fn(),
        notifyWaitTransition,
      },
    );
    try {
      if (execute === undefined) throw new Error("Terminal tool was not registered");
      // An old retained manager has no steering-specific method or new private fields.
      expect(manager).not.toHaveProperty("releaseForegroundWaits");
      const waiting = execute();
      const source = manager.list()[0]?.source;
      if (source === undefined) throw new Error("Terminal session was not started");
      const pid = manager.get(source)?.process?.pid;
      release();
      const result = (await waiting) as {
        details: {
          source: string;
          pid: number;
          background: boolean;
          status: string;
          waitReason: string;
        };
      };
      expect(result.details).toMatchObject({
        source,
        pid,
        background: true,
        status: "running",
        waitReason: "steering",
      });
      expect(notifyWaitTransition).not.toHaveBeenCalled();
      await manager.write(source, "hello");
      await manager.sendKeys(source, "Enter");
      const completed = await manager.wait(source);
      expect(completed.output).toContain("received:hello");
      expect(formatAgentTerminalSnapshot(manager.snapshot(completed))).not.toContain("next:");
      release();
    } finally {
      await manager.dispose();
    }
  },
);
