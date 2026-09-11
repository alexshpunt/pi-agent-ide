import { describe, expect, test, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TerminalUi } from "#src/plugins/pi-agent-ide-terminal/src/ui.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const active: TerminalSessionSnapshot = {
  id: "abcdef123456",
  source: "shell:abcdef123456",
  command: "pnpm dev",
  cwd: "/workspace",
  shell: "Bash",
  shellFamily: "posix",
  background: true,
  status: "running",
  startedAt: 0,
  elapsedMs: 1_000,
  output: "ready\n",
  outputStart: 0,
  outputEnd: 6,
  truncated: false,
  cols: 100,
  rows: 30,
};

describe("terminal activity preference", () => {
  test.each([
    { mode: "detailed" as const, widget: true, status: undefined },
    { mode: "compact" as const, widget: false, status: "terminals: 1" },
    { mode: "off" as const, widget: false, status: undefined },
  ])("renders $mode activity", ({ mode, widget, status }) => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const pi = extensionApi({
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    });
    const manager = {
      onDidChange: vi.fn(),
      onDidComplete: vi.fn(),
      list: () => [active],
    } as never;
    const terminalUi = new TerminalUi(pi, manager, mode);
    terminalUi.bind(
      extensionContext({
        hasUI: true,
        ui: { setWidget, setStatus },
      }),
    );

    expect(setWidget.mock.calls.some((call) => call[1] !== undefined)).toBe(widget);
    expect(setStatus).toHaveBeenLastCalledWith("agent-terminal", status);
    terminalUi.dispose();
  });
});

test("opens terminal details on enter and requires d plus confirmation to delete", async () => {
  let commandHandler: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  const remove = vi.fn(async () => undefined);
  const manager = {
    onDidChange: vi.fn(),
    onDidComplete: vi.fn(),
    list: () => [{ ...active, id: "old", source: "shell:old", status: "completed" }, active],
    get: () => active,
    snapshot: () => active,
    screenRows: () => ["", "latest terminal output"],
    delete: remove,
  } as never;
  const pi = extensionApi({
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn((_name: string, command: { handler: typeof commandHandler }) => {
      commandHandler = command.handler;
    }) as never,
    sendMessage: vi.fn(),
  });
  const terminalUi = new TerminalUi(pi, manager, "off");
  let customCalls = 0;
  const rendered: string[][] = [];
  const custom = vi.fn(
    async (
      factory: (
        tui: { requestRender(): void },
        currentTheme: ReturnType<typeof theme>,
        keybindings: Record<string, never>,
        done: (value: unknown) => void,
      ) => unknown,
    ) => {
      customCalls += 1;
      if (customCalls > 1) return null;
      let complete: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        complete = resolve;
      });
      const component = factory({ requestRender: vi.fn() }, theme(), {}, (value: unknown) =>
        complete?.(value),
      ) as { render(width: number): string[]; handleInput(data: string): void };
      component.handleInput("\r");
      rendered.push(component.render(100));
      expect(remove).not.toHaveBeenCalled();
      component.handleInput("d");
      rendered.push(component.render(100));
      expect(remove).not.toHaveBeenCalled();
      component.handleInput("y");
      return result;
    },
  );
  const context = extensionContext({
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      custom,
      notify: vi.fn(),
    } as never,
  });

  await commandHandler?.("", context);

  expect(rendered[0]?.join("\n")).not.toContain("shell:old");
  expect(rendered[0]?.join("\n")).toContain("latest terminal output");
  expect(rendered[1]?.join("\n")).toContain("y confirm");
  expect(remove).toHaveBeenCalledOnce();
  terminalUi.dispose();
});

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}
function extensionApi(
  value: Pick<ExtensionAPI, "registerMessageRenderer" | "registerCommand" | "sendMessage">,
): ExtensionAPI {
  return value as ExtensionAPI;
}

function extensionContext(
  value: Pick<ExtensionContext, "hasUI"> &
    Partial<Pick<ExtensionContext, "mode">> & {
      readonly ui: Pick<ExtensionContext["ui"], "setWidget" | "setStatus">;
    },
): ExtensionContext {
  return value as ExtensionContext;
}
