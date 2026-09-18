import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";

import type { AgentIdeProcess, AgentIdeProcessRegistry } from "./registry.js";

export type ProcessActivityMode = "detailed" | "compact" | "off";

/** Owns the unified active-process widget and `/agent-ide-processes` overlay. */
export class AgentIdeProcessesUi {
  #context: ExtensionContext | undefined;
  #closed = false;
  #elapsedTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly registry: AgentIdeProcessRegistry,
    private readonly activityMode: ProcessActivityMode,
    pi: ExtensionAPI,
  ) {
    registry.onDidChange(() => this.#render());
    pi.registerCommand("agent-ide-processes", {
      description: "Show active terminal and debugger processes created by Agent IDE",
      handler: async (_args, context) => {
        this.bind(context);
        if (context.mode !== "tui") {
          context.ui.notify("The Agent IDE process overlay requires the TUI.", "info");
          return;
        }
        await this.#showOverlay(context);
      },
    });
  }

  bind(context: ExtensionContext): void {
    if (this.#closed) return;
    this.#context = context;
    this.#render();
  }

  dispose(): void {
    this.#closed = true;
    if (this.#elapsedTimer !== undefined) clearInterval(this.#elapsedTimer);
    this.#elapsedTimer = undefined;
    this.#context?.ui.setWidget("agent-ide-processes", undefined);
    this.#context?.ui.setStatus("agent-ide-processes", undefined);
    this.#context = undefined;
  }

  #active(): readonly AgentIdeProcess[] {
    return this.registry.list();
  }

  #render(): void {
    const context = this.#context;
    if (this.#closed || context === undefined || !context.hasUI) return;
    const active = this.#active();
    if (this.activityMode === "off" || active.length === 0) {
      context.ui.setWidget("agent-ide-processes", undefined);
      context.ui.setStatus("agent-ide-processes", undefined);
      if (this.#elapsedTimer !== undefined) clearInterval(this.#elapsedTimer);
      this.#elapsedTimer = undefined;
      return;
    }
    if (this.activityMode === "compact") {
      context.ui.setWidget("agent-ide-processes", undefined);
      context.ui.setStatus("agent-ide-processes", `Agent IDE processes: ${active.length}`);
      return;
    }
    context.ui.setStatus("agent-ide-processes", undefined);
    context.ui.setWidget(
      "agent-ide-processes",
      (_tui, theme) => ({
        invalidate() {},
        render: (width: number) => renderProcessWidget(active, width, theme),
      }),
      { placement: "belowEditor" },
    );
    this.#elapsedTimer ??= setInterval(() => this.#render(), 1_000);
  }

  async #showOverlay(context: ExtensionContext): Promise<void> {
    for (;;) {
      if (this.#active().length === 0) {
        context.ui.notify("No active Agent IDE processes.", "info");
        return;
      }

      let disposeRefresh: () => void = () => undefined;
      let refreshTimer: ReturnType<typeof setInterval> | undefined;
      let action: { readonly source: string } | null;
      try {
        action = await context.ui.custom<{ readonly source: string } | null>(
          (tui, theme, _keys, done) => {
            let active = this.#active();
            let page: "list" | "detail" | "input" | "confirm" = "list";
            let selected: AgentIdeProcess | undefined;
            const createList = (selectedSource?: string): SelectList => {
              const items: SelectItem[] = active.map((process) => ({
                value: process.source,
                label: `${process.status}  ${process.kind}  ${process.title}`,
                description: process.description,
              }));
              const next = new SelectList(items, Math.min(items.length, 12), {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
              });
              const selectedIndex = items.findIndex((item) => item.value === selectedSource);
              if (selectedIndex >= 0) next.setSelectedIndex(selectedIndex);
              next.onSelect = (item) => {
                selected = active.find((process) => process.source === item.value);
                page = "detail";
                tui.requestRender();
              };
              next.onCancel = () => done(null);
              return next;
            };
            let list = createList();
            const refresh = (): void => {
              const selectedSource = selected?.source ?? list.getSelectedItem()?.value;
              active = this.#active();
              selected =
                page === "list"
                  ? undefined
                  : active.find((process) => process.source === selectedSource);
              list = createList(selectedSource);
              tui.requestRender();
            };
            disposeRefresh = this.registry.onDidChange(refresh);
            refreshTimer = setInterval(refresh, 1_000);

            return {
              invalidate: () => list.invalidate(),
              render(width: number) {
                const container = new Container();

                if (page === "list") {
                  container.addChild(list);
                  container.addChild(
                    new Text(
                      theme.fg(
                        "dim",
                        active.length === 0 ? "esc close" : "enter view · d stop · esc close",
                      ),
                      1,
                      0,
                    ),
                  );
                } else if (selected === undefined) {
                  container.addChild(
                    new Text(theme.fg("warning", "Process is no longer active."), 1, 0),
                  );
                  container.addChild(new Text(theme.fg("dim", "esc back"), 1, 0));
                } else {
                  container.addChild(selected.renderDetail(theme));
                  container.addChild(
                    new Text(
                      theme.fg(
                        page === "confirm" ? "warning" : "dim",
                        page === "confirm"
                          ? "Stop this process? y confirm · n/esc cancel"
                          : page === "input"
                            ? "input mode · type to send · esc stop input"
                            : selected.sendInput === undefined
                              ? "esc back · d stop"
                              : "i input · esc back · d stop",
                      ),
                      1,
                      0,
                    ),
                  );
                }
                const accent = (text: string): string => theme.fg("accent", text);
                const innerWidth = Math.max(1, width - 2);
                return [
                  borderTop("Agent IDE Processes", `${active.length} active`, width, accent),
                  ...container.render(innerWidth).map((line) => borderLine(line, width, accent)),
                  borderBottom(width, accent),
                ];
              },
              handleInput(data: string) {
                if (page === "list") {
                  if (data === "d") {
                    selected = active.find(
                      (process) => process.source === list.getSelectedItem()?.value,
                    );
                    if (selected !== undefined) page = "confirm";
                  } else list.handleInput(data);
                } else if (page === "detail") {
                  if (matchesKey(data, Key.escape)) page = "list";
                  else if (data === "d" && selected !== undefined) page = "confirm";
                  else if (data === "i" && selected?.sendInput !== undefined) page = "input";
                } else if (page === "input") {
                  if (matchesKey(data, Key.escape)) page = "detail";
                  else selected?.sendInput?.(data);
                } else if (data === "y" && selected !== undefined)
                  done({ source: selected.source });
                else if (data === "n" || matchesKey(data, Key.escape)) page = "detail";
                tui.requestRender();
              },
            };
          },
          { overlay: true, overlayOptions: { width: "75%", maxHeight: "80%", minWidth: 52 } },
        );
      } finally {
        disposeRefresh();
        if (refreshTimer !== undefined) clearInterval(refreshTimer);
      }
      if (action === null) return;
      const process = this.#active().find((candidate) => candidate.source === action.source);
      if (process !== undefined) await process.stop();
    }
  }
}

/** Render all active process kinds in one stable shared widget. */
export function renderProcessWidget(
  processes: readonly AgentIdeProcess[],
  width: number,
  theme: Theme,
): string[] {
  if (processes.length === 0) return [];
  const accent = (text: string) => theme.fg("accent", text);
  const lines = [borderTop("Agent IDE Processes", `${processes.length} active`, width, accent)];
  for (const [index, process] of processes.entries()) {
    for (const line of process.renderSummary(theme))
      lines.push(borderLine(` ${line} `, width, accent));
    if (index < processes.length - 1) lines.push(borderLine("", width, accent));
  }
  lines.push(borderBottom(width, accent));
  return lines;
}

function borderTop(
  title: string,
  info: string,
  width: number,
  accent: (text: string) => string,
): string {
  if (width <= 1) return accent("╭");
  const inner = width - 2;
  const left = `─ ${title} `;
  const right = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right)));
  return accent(`╭${truncateToWidth(`${left}${fill}${right}`, inner).padEnd(inner, "─")}╮`);
}
function borderLine(line: string, width: number, accent: (text: string) => string): string {
  if (width <= 1) return accent("│");
  const inner = width - 2;
  const clipped = truncateToWidth(line, inner);
  return `${accent("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${accent("│")}`;
}
function borderBottom(width: number, accent: (text: string) => string): string {
  return accent(width <= 1 ? "╰" : `╰${"─".repeat(width - 2)}╯`);
}
