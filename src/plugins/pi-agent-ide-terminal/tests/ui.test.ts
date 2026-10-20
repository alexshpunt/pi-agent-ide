import { describe, expect, test, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";
import type {
  TerminalSession,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

describe("terminal completion UI", () => {
  test("separates mixed completion owners while delivering the full batch to the agent once", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const appendEntry = vi.fn();
      const manager = fakeManager();
      const ui = new TerminalUi(
        extensionApi({
          registerMessageRenderer: vi.fn(),
          registerCommand: vi.fn(),
          sendMessage,
          appendEntry,
        }),
        manager.value,
      );
      ui.bind({
        isIdle: () => true,
        sessionManager: { getSessionId: () => "session-a" },
      } as ExtensionContext);
      const make = (id: string, owner?: string) => ({
        ...backgroundSession(),
        id,
        source: `shell:${id}`,
        ...(owner
          ? {
              origin: {
                toolCallId: `${owner}-child`,
                parentToolCallId: owner,
                sessionId: "session-a",
              },
            }
          : {}),
      });
      const sessions = [
        make("one", "root-a"),
        {
          ...make("two", "root-b"),
          shell: {
            ...backgroundSession().shell,
            displayName: "PowerShell",
            family: "powershell" as const,
          },
        },
        make("three", "root-a"),
        make("ownerless"),
      ];
      for (const session of sessions) manager.complete(session);
      vi.advanceTimersByTime(120);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        customType: "terminal-completion",
        display: false,
        details: {
          sessions: sessions.map((session) => ({ id: session.id })),
        },
      });
      expect(
        (
          appendEntry.mock.calls as [
            string,
            { parentToolCallId?: string; sessions: TerminalSessionSnapshot[] },
          ][]
        ).map(([type, data]) => [
          type,
          data.parentToolCallId,
          data.sessions.map((session: TerminalSessionSnapshot) => session.id),
        ]),
      ).toEqual([
        ["terminal-completion-display", "root-a", ["one", "three"]],
        ["terminal-completion-display", "root-b", ["two"]],
        ["terminal-completion-display", undefined, ["ownerless"]],
      ]);
      expect(appendEntry.mock.calls[2]?.[1]).not.toHaveProperty("parentToolCallId");
      for (const session of sessions) manager.complete(session);
      vi.advanceTimersByTime(120);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledTimes(3);
      ui.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stale and interrupted-wait notices retain the launch, not the latest context", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const appendEntry = vi.fn();
      const manager = fakeManager();
      const ui = new TerminalUi(
        extensionApi({
          registerMessageRenderer: vi.fn(),
          registerCommand: vi.fn(),
          sendMessage,
          appendEntry,
        }),
        manager.value,
        100,
      );
      const context = {
        isIdle: () => true,
        sessionManager: { getSessionId: () => "session-a" },
      } as ExtensionContext;
      ui.bind(context);
      const session = {
        ...backgroundSession(),
        origin: { toolCallId: "child", parentToolCallId: "launch", sessionId: "session-a" },
      };
      manager.change(session);
      vi.advanceTimersByTime(100);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        customType: "terminal-stale",
        display: false,
      });
      expect(appendEntry.mock.calls[0]).toMatchObject([
        "terminal-stale-display",
        { parentToolCallId: "launch", origin: session.origin },
      ]);
      ui.notifyWaitTransition(session);
      expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
        customType: "terminal-wait-transition",
        display: false,
        details: { origin: session.origin },
      });
      // A retained process in a different session must not attach to a reused call ID.
      ui.bind({
        isIdle: () => true,
        sessionManager: { getSessionId: () => "session-b" },
      } as ExtensionContext);
      manager.complete(session);
      vi.advanceTimersByTime(120);
      expect(appendEntry.mock.calls[1]?.[1]).not.toHaveProperty("parentToolCallId");
      expect(appendEntry.mock.calls[1]?.[1]).toMatchObject({
        sessions: [{ origin: session.origin }],
      });
      ui.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  test("recovers an undelivered completion from the retained manager after UI replacement", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const appendEntry = vi.fn();
      const manager = fakeManager();
      const pi = extensionApi({
        registerMessageRenderer: vi.fn(),
        registerCommand: vi.fn(),
        sendMessage,
        appendEntry,
      });
      const context = {
        isIdle: () => true,
        sessionManager: { getSessionId: () => "session-a" },
      } as ExtensionContext;
      const session = {
        ...backgroundSession(),
        origin: { toolCallId: "direct", parentToolCallId: "direct", sessionId: "session-a" },
      };
      const original = new TerminalUi(pi, manager.value);
      original.bind(context);
      manager.change(session);
      manager.complete(session);
      original.dispose();
      const reloaded = new TerminalUi(pi, manager.value);
      reloaded.bind(context);
      vi.advanceTimersByTime(120);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(appendEntry.mock.calls[0]?.[1]).toMatchObject({ parentToolCallId: "direct" });
      reloaded.bind(context);
      vi.advanceTimersByTime(120);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      reloaded.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
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

  test("wakes an idle agent only once per session despite later activity", () => {
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

      vi.advanceTimersByTime(360_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      session.lastActivityAt = Date.now();
      manager.change(session);
      vi.advanceTimersByTime(240_000);
      ui.onAgentSettled({ isIdle: () => true } as ExtensionContext);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      const another = { ...backgroundSession(), id: "second", source: "shell:second" };
      manager.change(another);
      vi.advanceTimersByTime(120_000);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      ui.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps the reminder consumed across UI reload and still delivers completion", () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn();
      const manager = fakeManager();
      const pi = extensionApi({
        registerMessageRenderer: vi.fn(),
        registerCommand: vi.fn(),
        sendMessage,
      });
      const context = { isIdle: () => true } as ExtensionContext;
      const ui = new TerminalUi(pi, manager.value, 120_000);
      ui.bind(context);
      const session = backgroundSession();
      manager.change(session);
      vi.advanceTimersByTime(120_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      ui.dispose();

      const reloaded = new TerminalUi(pi, manager.value, 120_000);
      reloaded.bind(context);
      manager.change(session);
      vi.advanceTimersByTime(360_000);
      reloaded.onAgentSettled(context);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      manager.complete(session);
      vi.advanceTimersByTime(120);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.lastCall?.[0]).toMatchObject({
        customType: "terminal-completion",
      });
      expect(session.completionDelivered).toBe(true);
      reloaded.dispose();
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
    staleReminderDelivered: false,
  };
}

function fakeManager() {
  let changeListener: ((session: TerminalSession) => void) | undefined;
  let completeListener: ((session: TerminalSession) => void) | undefined;
  const sessions = new Map<string, TerminalSession>();
  return {
    sessions,
    complete(session: TerminalSession) {
      session.status = "completed";
      completeListener?.(session);
    },
    change(session: TerminalSession) {
      sessions.set(session.id, session);
      changeListener?.(session);
    },
    value: {
      list() {
        return [...sessions.values()].map((session) => ({ id: session.id }));
      },
      onDidChange(listener: (session: TerminalSession) => void) {
        changeListener = listener;
        return () => {
          changeListener = undefined;
        };
      },
      onDidComplete(listener: (session: TerminalSession) => void) {
        completeListener = listener;
        return () => {
          completeListener = undefined;
        };
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
          shell: session.shell.displayName,
          shellFamily: session.shell.family,
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
  value: Pick<ExtensionAPI, "registerMessageRenderer" | "registerCommand" | "sendMessage"> &
    Partial<Pick<ExtensionAPI, "appendEntry">>,
): ExtensionAPI {
  const api: Partial<ExtensionAPI> = {
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
    ...value,
  };
  return api as ExtensionAPI;
}
