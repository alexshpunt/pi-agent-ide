import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";

import {
  renderTerminalResult,
  renderTerminalWidgetLines,
} from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import type {
  TerminalSession,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const COMPLETION_DELAY_MS = 120;

/** Keeps background terminal status and completion rendering separate from agent result data. */
export class TerminalUi {
  readonly #pending = new Map<string, TerminalSession>();
  #context: ExtensionContext | undefined;
  #deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  #elapsedTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  public constructor(
    private readonly pi: ExtensionAPI,
    private readonly manager: TerminalSessionManager,
    private readonly activityMode: "detailed" | "compact" | "off",
  ) {
    pi.registerMessageRenderer("terminal-completion", (message, { expanded }, theme) => {
      const content = new Container();
      for (const session of completionSnapshots(message.details)) {
        content.addChild(renderTerminalResult(session, expanded, theme));
      }
      const card = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
      card.addChild(content);
      return card;
    });

    manager.onDidChange(() => this.#renderActive());
    manager.onDidComplete((session) => {
      if (session.background) this.#queueCompletion(session);
      this.#renderActive();
    });

    pi.registerCommand("terminals", {
      description: "Show active and recent terminal sessions",
      handler: async (_args, context) => {
        this.bind(context);
        if (context.mode !== "tui") {
          context.ui.notify("The terminal session overlay requires the TUI.", "info");
          return;
        }
        await this.#showOverlay(context);
      },
    });
  }

  public bind(context: ExtensionContext): void {
    if (this.#closed) return;
    this.#context = context;
    this.#renderActive();
  }

  public dispose(): void {
    this.#closed = true;
    if (this.#deliveryTimer !== undefined) clearTimeout(this.#deliveryTimer);
    if (this.#elapsedTimer !== undefined) clearInterval(this.#elapsedTimer);
    this.#deliveryTimer = undefined;
    this.#elapsedTimer = undefined;
    this.#context?.ui.setWidget("agent-terminal", undefined);
    this.#context?.ui.setStatus("agent-terminal", undefined);
    this.#pending.clear();
    this.#context = undefined;
  }

  #queueCompletion(session: TerminalSession): void {
    if (this.#closed || session.completionDelivered) return;
    this.#pending.set(session.id, session);
    if (this.#deliveryTimer !== undefined) return;
    this.#deliveryTimer = setTimeout(() => {
      this.#deliveryTimer = undefined;
      const sessions = [...this.#pending.values()].filter(
        (session) => !session.completionDelivered,
      );
      this.#pending.clear();
      if (this.#closed || sessions.length === 0) return;
      for (const completed of sessions) completed.completionDelivered = true;
      const snapshots = sessions.map((completed) => this.manager.snapshot(completed));
      const content = formatCompletionMessage(snapshots);
      this.pi.sendMessage(
        {
          customType: "terminal-completion",
          display: true,
          content,
          details: { sessions: snapshots },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }, COMPLETION_DELAY_MS);
  }

  #renderActive(): void {
    const context = this.#context;
    if (this.#closed || context === undefined || !context.hasUI) return;
    const active = this.manager
      .list()
      .filter((session) => session.status === "running" || session.status === "stopping");
    if (this.activityMode === "off") {
      context.ui.setWidget("agent-terminal", undefined);
      context.ui.setStatus("agent-terminal", undefined);
      return;
    }
    if (active.length === 0) {
      context.ui.setWidget("agent-terminal", undefined);
      context.ui.setStatus("agent-terminal", undefined);
      if (this.#elapsedTimer !== undefined) clearInterval(this.#elapsedTimer);
      this.#elapsedTimer = undefined;
      return;
    }
    if (this.activityMode === "compact") {
      context.ui.setWidget("agent-terminal", undefined);
      context.ui.setStatus("agent-terminal", `terminals: ${active.length}`);
      return;
    }
    context.ui.setStatus("agent-terminal", undefined);
    context.ui.setWidget(
      "agent-terminal",
      (_tui, theme) => ({
        invalidate() {},
        render: (width: number) => renderTerminalWidgetLines(active, width, theme),
      }),
      { placement: "belowEditor" },
    );
    if (this.#elapsedTimer === undefined) {
      this.#elapsedTimer = setInterval(() => this.#renderActive(), 1_000);
    }
  }

  async #showOverlay(context: ExtensionContext): Promise<void> {
    for (;;) {
      const sessions = this.manager
        .list()
        .filter((session) => session.status === "running" || session.status === "stopping");
      if (sessions.length === 0) {
        context.ui.notify("No active terminal sessions.", "info");
        return;
      }
      const action = await context.ui.custom<TerminalOverlayAction | null>(
        (tui, theme, _keybindings, done) => {
          const items: SelectItem[] = sessions.map((session) => ({
            value: session.source,
            label: `${session.status}  ${formatElapsed(session.elapsedMs)}  ${session.shell}`,
            description: shortCommand(session.command, 90),
          }));
          const list = new SelectList(items, Math.min(items.length, 12), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          let page: "list" | "detail" | "confirm" = "list";
          let selectedSource: string | undefined;
          list.onSelect = (item) => {
            selectedSource = item.value;
            page = "detail";
          };
          list.onCancel = () => done(null);
          return {
            render: (width: number) => {
              const container = new Container();
              container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
              if (page === "list") {
                container.addChild(
                  new Text(theme.fg("accent", theme.bold("Terminal sessions")), 1, 0),
                );
                container.addChild(list);
                container.addChild(
                  new Text(theme.fg("dim", "enter view · d delete · esc close"), 1, 0),
                );
              } else {
                const session =
                  selectedSource === undefined ? undefined : this.manager.get(selectedSource);
                if (session === undefined) {
                  container.addChild(
                    new Text(theme.fg("warning", "Terminal is no longer available."), 1, 0),
                  );
                } else {
                  const snapshot = this.manager.snapshot(session);
                  container.addChild(
                    new Text(theme.fg("accent", theme.bold(`${snapshot.shell} terminal`)), 1, 0),
                  );
                  container.addChild(
                    new Text(
                      theme.fg(
                        "muted",
                        truncateToWidth(
                          `${snapshot.status} · ${formatElapsed(snapshot.elapsedMs)} · ${snapshot.cwd}`,
                          Math.max(1, width - 2),
                        ),
                      ),
                      1,
                      0,
                    ),
                  );
                  container.addChild(new Text(theme.fg("text", `$ ${snapshot.command}`), 1, 0));
                  const rows = visibleScreenTail(this.manager.screenRows(session), 24);
                  container.addChild(
                    new Text(
                      rows.map((row) => theme.fg("toolOutput", row || " ")).join("\n"),
                      1,
                      0,
                    ),
                  );
                  container.addChild(
                    new Text(
                      theme.fg(
                        page === "confirm" ? "warning" : "dim",
                        page === "confirm"
                          ? "Delete this terminal session? y confirm · n/esc cancel"
                          : "esc back · d delete",
                      ),
                      1,
                      0,
                    ),
                  );
                }
              }
              container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
              return container.render(width);
            },
            handleInput: (data: string) => {
              if (page === "list") {
                if (data === "d") {
                  selectedSource = list.getSelectedItem()?.value;
                  if (selectedSource !== undefined) page = "confirm";
                } else {
                  list.handleInput(data);
                }
              } else if (page === "detail") {
                if (matchesKey(data, Key.escape)) page = "list";
                else if (data === "d") page = "confirm";
              } else if (data === "y" && selectedSource !== undefined) {
                done({ kind: "delete", source: selectedSource });
              } else if (data === "n" || matchesKey(data, Key.escape)) {
                page = "detail";
              }
              tui.requestRender();
            },
            invalidate: () => list.invalidate(),
          };
        },
        { overlay: true, overlayOptions: { width: "75%", maxHeight: "80%", minWidth: 52 } },
      );
      if (action === null) return;
      await this.manager.delete(action.source);
      context.ui.notify("Terminal session deleted.", "info");
    }
  }
}

function visibleScreenTail(rows: readonly string[], limit: number): readonly string[] {
  const first = rows.findIndex((row) => row.length > 0);
  if (first === -1) return ["(no visible output)"];
  let last = rows.length - 1;
  while (last > first && rows[last]?.length === 0) last -= 1;
  return rows.slice(Math.max(first, last - limit + 1), last + 1);
}
type TerminalOverlayAction = { readonly kind: "delete"; readonly source: string };
function completionSnapshots(details: unknown): readonly TerminalSessionSnapshot[] {
  if (!isRecord(details) || !Array.isArray(details.sessions)) return [];
  return details.sessions.filter(isTerminalSessionSnapshot);
}

function isTerminalSessionSnapshot(value: unknown): value is TerminalSessionSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    typeof value.shell === "string" &&
    (value.shellFamily === "posix" ||
      value.shellFamily === "powershell" ||
      value.shellFamily === "cmd") &&
    typeof value.background === "boolean" &&
    typeof value.status === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.elapsedMs === "number" &&
    typeof value.output === "string" &&
    typeof value.outputStart === "number" &&
    typeof value.outputEnd === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.cols === "number" &&
    typeof value.rows === "number"
  );
}

function formatCompletionMessage(sessions: readonly TerminalSessionSnapshot[]): string {
  const heading =
    sessions.length === 1 ? "Background terminal completed:" : "Background terminals completed:";
  return `${heading}\n${sessions
    .map((session) => {
      const exit = session.exitCode === undefined ? "" : `, exit ${session.exitCode}`;
      const excerpt = session.output.trimEnd().slice(-2_000);
      return `- ${session.source}: ${session.status}${exit}, ${formatElapsed(session.elapsedMs)}\n${excerpt || "(no output)"}`;
    })
    .join("\n")}`;
}

function shortCommand(command: string, max = 60): string {
  const singleLine = command.replaceAll(/\s+/gu, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
