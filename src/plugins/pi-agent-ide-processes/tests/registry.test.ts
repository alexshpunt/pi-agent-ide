import { describe, expect, test, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";

import { AgentIdeProcessRegistry } from "#src/plugins/pi-agent-ide-processes/src/registry.js";
import {
  AgentIdeProcessesUi,
  renderProcessWidget,
} from "#src/plugins/pi-agent-ide-processes/src/ui.js";

describe("Agent IDE process registry", () => {
  test("combines active contributions and removes a provider cleanly", () => {
    const registry = new AgentIdeProcessRegistry();
    const listener = vi.fn();
    registry.onDidChange(listener);
    const remove = registry.add({
      id: "terminal",
      list: () => [process("shell:one", "terminal")],
      onDidChange: () => () => undefined,
    });
    registry.add({
      id: "debugger",
      list: () => [process("debug:one", "debugger")],
      onDidChange: () => () => undefined,
    });

    expect(registry.list().map(({ source }) => source)).toEqual(["shell:one", "debug:one"]);
    remove();
    expect(registry.list().map(({ source }) => source)).toEqual(["debug:one"]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test("registers only the namespaced process command", () => {
    const registerCommand = vi.fn();
    const registry = new AgentIdeProcessRegistry();
    const ui = new AgentIdeProcessesUi(registry, "off", { registerCommand } as never);

    expect(registerCommand.mock.calls[0]?.[0]).toBe("agent-ide-processes");
    expect(registerCommand).not.toHaveBeenCalledWith("terminals", expect.anything());
    expect(registerCommand).not.toHaveBeenCalledWith("debuggers", expect.anything());
    ui.dispose();
  });
  test("keeps an open process detail live and stops refreshing after close", async () => {
    vi.useFakeTimers();
    let commandHandler: ((args: string, context: never) => Promise<void>) | undefined;
    let providerListener: () => void = () => undefined;
    let detail = "old output";
    const requestRender = vi.fn();
    const sendInput = vi.fn();
    let component:
      | {
          render(width: number): string[];
          handleInput?(data: string): void;
        }
      | undefined;
    let closeOverlay: ((value: null) => void) | undefined;
    const registry = new AgentIdeProcessRegistry();
    registry.add({
      id: "terminal",
      list: () => [{ ...processWithDetail("shell:one", detail), sendInput }],
      onDidChange(listener) {
        providerListener = listener;
        return () => {
          providerListener = () => undefined;
        };
      },
    });
    const ui = new AgentIdeProcessesUi(registry, "off", {
      registerCommand: (_name: string, command: { handler: typeof commandHandler }) => {
        commandHandler = command.handler;
      },
    } as never);
    const overlay = new Promise<null>((resolve) => {
      closeOverlay = resolve;
    });
    const context = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        setStatus: vi.fn(),
        custom: vi.fn(
          (
            factory: (
              tui: { requestRender(): void },
              currentTheme: ReturnType<typeof theme>,
              keys: undefined,
              done: (value: null) => void,
            ) => NonNullable<typeof component>,
          ) => {
            component = factory({ requestRender }, theme(), undefined, (value: null) =>
              closeOverlay?.(value),
            );
            return overlay;
          },
        ),
      },
    };

    const running = commandHandler?.("", context as never);
    component?.handleInput?.("\r");
    expect(component?.render(80).join("\n")).toContain("old output");
    expect(component?.render(80).join("\n")).toContain("i input");
    component?.handleInput?.("i");
    expect(component?.render(80).join("\n")).toContain("input mode");
    component?.handleInput?.("typed text");
    expect(sendInput).toHaveBeenCalledWith("typed text");
    component?.handleInput?.("\u001b");
    expect(component?.render(80).join("\n")).toContain("i input");
    requestRender.mockClear();

    detail = "new output";
    providerListener();
    expect(requestRender).toHaveBeenCalled();
    expect(component?.render(80).join("\n")).toContain("new output");

    requestRender.mockClear();
    detail = "timer output";
    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalled();
    expect(component?.render(80).join("\n")).toContain("timer output");
    closeOverlay?.(null);
    await running;
    requestRender.mockClear();
    providerListener();
    vi.advanceTimersByTime(1_000);
    expect(requestRender).not.toHaveBeenCalled();
    ui.dispose();
    vi.useRealTimers();
  });
  test("renders different process kinds inside one Agent IDE Processes block", () => {
    const lines = renderProcessWidget(
      [process("shell:one", "terminal"), process("debug:one", "debugger")],
      80,
      theme() as never,
    );
    const text = lines.join("\n");
    expect(text).toContain("Agent IDE Processes");
    expect(text).toContain("2 active");
    expect(text).toContain("terminal · shell:one");
    expect(text).toContain("debugger · debug:one");
  });
});

function process(source: string, kind: string) {
  return {
    source,
    kind,
    title: kind,
    description: source,
    status: "running" as const,
    renderSummary: () => [`${kind} · ${source}`],
    renderDetail: () => new Text(source, 0, 0),
    stop: async () => undefined,
  };
}
function processWithDetail(source: string, detail: string) {
  return {
    ...process(source, "terminal"),
    renderDetail: () => new Text(detail, 0, 0),
  };
}
function theme() {
  return { fg: (_color: string, text: string) => text };
}
