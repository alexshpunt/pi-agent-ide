import { describe, expect, test, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";
import type {
  TerminalSession,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

describe("terminal completion UI", () => {
  test("registers completion and stale rendering without owning a process command", () => {
    const registerMessageRenderer = vi.fn();
    const registerCommand = vi.fn();
    const manager = fakeManager();
    const pi = extensionApi({ registerMessageRenderer, registerCommand, sendMessage: vi.fn() });

    const ui = new TerminalUi(pi, manager.value);

    expect(registerMessageRenderer).toHaveBeenCalledWith(
      "terminal-completion",
      expect.any(Function),
    );
    expect(registerMessageRenderer).toHaveBeenCalledWith("terminal-stale", expect.any(Function));
    expect(registerCommand).not.toHaveBeenCalled();
    ui.dispose();
  });

  test("wakes an idle agent after each stale interval and resets on activity", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const manager = fakeManager();
      const ui = new TerminalUi(
        extensionApi({ registerMessageRenderer: vi.fn(), registerCommand: vi.fn(), sendMessage }),
        manager.value,
        120_000,
      );
      ui.bind({ isIdle: () => true } as ExtensionContext);
      const session = backgroundSession();

      manager.change(session);
      vi.advanceTimersByTime(120_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const delivery = JSON.stringify(sendMessage.mock.lastCall);
      expect(delivery).toContain("terminal-stale");
      expect(delivery).toContain(session.source);
      expect(delivery).toContain('"triggerTurn":true');
      expect(delivery).toContain('"deliverAs":"followUp"');

      vi.advanceTimersByTime(120_000);
      expect(sendMessage).toHaveBeenCalledTimes(2);

      session.lastActivityAt = Date.now();
      manager.change(session);
      vi.advanceTimersByTime(119_999);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(sendMessage).toHaveBeenCalledTimes(3);
      ui.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("defers a stale wakeup until the agent settles", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const manager = fakeManager();
      let idle = false;
      const context = { isIdle: () => idle } as ExtensionContext;
      const ui = new TerminalUi(
        extensionApi({ registerMessageRenderer: vi.fn(), registerCommand: vi.fn(), sendMessage }),
        manager.value,
        120_000,
      );
      ui.bind(context);
      const session = backgroundSession();
      manager.sessions.set(session.id, session);
      manager.change(session);

      vi.advanceTimersByTime(120_000);
      expect(sendMessage).not.toHaveBeenCalled();
      idle = true;
      ui.onAgentSettled(context);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      ui.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

function backgroundSession(): TerminalSession {
  return {
    id: "abcdef123456",
    source: "shell:abcdef123456",
    command: "sleep 600",
    background: true,
    cwd: "/workspace",
    shell: { executable: "/bin/bash", displayName: "Bash", family: "posix", commandArgs: () => [] },
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    cols: 100,
    rows: 30,
    fullOutputPath: "/tmp/terminal-test.log",
    screen: {} as never,
    status: "running",
    output: "waiting",
    outputStart: 0,
    screenReady: Promise.resolve(),
    completion: new Promise(() => {}),
    resolveCompletion: () => {},
    completionDelivered: false,
  };
}

function fakeManager() {
  let changeListener: ((session: TerminalSession) => void) | undefined;
  const sessions = new Map<string, TerminalSession>();
  return {
    sessions,
    change(session: TerminalSession) {
      sessions.set(session.id, session);
      changeListener?.(session);
    },
    value: {
      onDidChange(listener: (session: TerminalSession) => void) {
        changeListener = listener;
        return () => {
          changeListener = undefined;
        };
      },
      onDidComplete(_listener: (session: TerminalSession) => void) {
        return () => {};
      },
      get(id: string) {
        return sessions.get(id.replace("shell:", ""));
      },
      snapshot(session: TerminalSession): TerminalSessionSnapshot {
        return {
          id: session.id,
          source: session.source,
          command: session.command,
          cwd: session.cwd,
          shell: "Bash",
          shellFamily: "posix",
          background: session.background,
          status: session.status,
          lastActivityAt: session.lastActivityAt,
          idleMs: Date.now() - session.lastActivityAt,
          startedAt: session.startedAt,
          elapsedMs: Date.now() - session.startedAt,
          output: session.output,
          outputStart: 0,
          outputEnd: session.output.length,
          truncated: false,
          fullOutputPath: "/tmp/terminal-test.log",
          cols: 100,
          rows: 30,
        };
      },
    } as never,
  };
}

function extensionApi(
  value: Pick<ExtensionAPI, "registerMessageRenderer" | "registerCommand" | "sendMessage">,
): ExtensionAPI {
  return value as ExtensionAPI;
}
