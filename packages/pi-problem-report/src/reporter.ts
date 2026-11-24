import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { guardComponent } from "./guard.ts";
import {
  errorMessage,
  problemKey,
  problemReport,
  type Problem,
  type ProblemReport,
  type ProblemSource,
} from "./report.ts";

/** The part of Pi's extension UI the reporter uses. */
export interface ProblemUi {
  setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ProblemReporterOptions {
  /** Defaults to Pi's clipboard. */
  readonly copy?: (text: string) => Promise<void>;
  /** Whether the user wants problem panels; checked on every show, attach and refresh. */
  readonly enabled?: () => boolean;
  /** Turns problem panels off for good; when given, the panel offers a button for it. */
  readonly disable?: () => void | Promise<void>;
  /** Shown after `disable`, such as where to turn the panels back on. */
  readonly disabledNotice?: string;
  readonly widgetKey?: string;
  /**
   * A slash command that runs `act`, such as `agent-ide-problem`. The panel then names it, because
   * its buttons can be clicked only where Pi routes the mouse to components, as in fullscreen mode.
   */
  readonly command?: string;
}

export type ProblemAction = "open" | "copy" | "disable" | "close";

/** The problem on screen, with what its actions need. */
interface Shown {
  readonly key: string;
  readonly problem: Problem;
  report?: ProblemReport;
  /** The terminal the panel was last drawn for; needed to open a link in the browser. */
  tui?: TUI;
}

const DEFAULT_CONSEQUENCE = "Pi keeps working. Please report this so it can be fixed:";

function notify(ui: ProblemUi, message: string, type: "info" | "error"): void {
  try {
    ui.notify(message, type);
  } catch {
    // The UI may already be gone.
  }
}

const hyperlink = (url: string, text: string): string =>
  `\u001B]8;;${url}\u001B\\${text}\u001B]8;;\u001B\\`;

/**
 * Widget above the editor that names the problem and offers a prefilled issue. It stays until
 * closed, because a short notification is easy to miss.
 */
export class ProblemPanel implements Component {
  private actionsRow = -1;
  private readonly spans: { action: ProblemAction; start: number; end: number }[] = [];

  constructor(
    private readonly source: ProblemSource,
    private readonly problem: Problem,
    private readonly report: ProblemReport,
    private readonly theme: Theme,
    private readonly actions: readonly { action: ProblemAction; label: string }[],
    private readonly act: (action: ProblemAction) => void,
    /** A line naming the slash command that performs the same actions. */
    private readonly commandHint?: string,
  ) {}

  render(width: number): string[] {
    const theme = this.theme;
    const message = errorMessage(this.problem.error);
    const inner = Math.max(1, width - 3);
    const wrap = (text: string): string[] =>
      wrapTextWithAnsi(text, inner).map((line) => `   ${line}`);
    const lines = [
      truncateToWidth(
        ` ${theme.fg("warning", "⚠ ")}${theme.bold(`${this.source.name} ${this.problem.summary}`)}`,
        width,
      ),
      ...(message ? wrap(theme.fg("muted", message)) : []),
      ...wrap(theme.fg("dim", this.problem.consequence ?? DEFAULT_CONSEQUENCE)),
      truncateToWidth(
        `   ${hyperlink(this.source.issuesUrl, theme.fg("accent", this.source.issuesUrl))}`,
        width,
      ),
    ];
    const hint = this.commandHint ? wrap(theme.fg("dim", this.commandHint)) : [];
    this.spans.length = 0;
    let column = 3;
    let row = "   ";
    for (const { action, label } of this.actions) {
      const styled = theme.fg("accent", label);
      row += `${action === "open" ? hyperlink(this.report.url, styled) : styled} `;
      this.spans.push({ action, start: column, end: column + visibleWidth(label) });
      column += visibleWidth(label) + 1;
    }
    this.actionsRow = lines.length;
    lines.push(truncateToWidth(row, width), ...hint);
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || event.y !== this.actionsRow) return undefined;
    const span = this.spans.find(
      (candidate) => event.x >= candidate.start && event.x < candidate.end,
    );
    if (!span) return undefined;
    // Like Pi's own buttons: capture the press, act on the click that follows its release.
    if (event.type === "press") return { capture: true };
    if (event.type === "click") {
      this.act(span.action);
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  invalidate(): void {}
}

/**
 * Shows one problem at a time above the editor. Problems reported before a UI exists wait for
 * `attach`; a problem the user closed does not come back while this reporter lives.
 */
export class ProblemReporter {
  private ui: ProblemUi | undefined;
  private current: Shown | undefined;
  private readonly queue: Shown[] = [];
  private readonly closed = new Set<string>();
  private readonly copy: (text: string) => Promise<void>;
  private readonly widgetKey: string;

  constructor(
    private readonly source: ProblemSource,
    private readonly options: ProblemReporterOptions = {},
  ) {
    this.copy = options.copy ?? copyToClipboard;
    this.widgetKey = options.widgetKey ?? `${source.name}-problem`;
  }

  /** A UI became available, such as at session start; shows the first waiting problem. */
  attach(ui: ProblemUi): void {
    if (this.ui !== ui) this.clearWidget();
    this.ui = ui;
    this.refresh();
  }

  /** The UI is going away; the shown problem waits for the next `attach`. */
  detach(): void {
    this.clearWidget();
    if (this.current) this.queue.unshift(this.current);
    this.current = undefined;
    this.ui = undefined;
  }

  show(problem: Problem): void {
    try {
      if (!this.isEnabled()) return;
      const key = problemKey(problem);
      if (
        this.closed.has(key) ||
        this.current?.key === key ||
        this.queue.some((entry) => entry.key === key)
      )
        return;
      this.queue.push({ key, problem });
      this.refresh();
    } catch {
      // Reporting a problem must never cause another one.
    }
  }

  /** Apply the current `enabled` value: hide the panel when off, show a waiting problem when on. */
  refresh(): void {
    try {
      if (!this.isEnabled()) {
        this.clearWidget();
        if (this.current) this.queue.unshift(this.current);
        this.current = undefined;
        return;
      }
      if (this.current || !this.ui) return;
      const next = this.queue.shift();
      if (next) this.display(next);
    } catch {
      // Reporting a problem must never cause another one.
    }
  }

  private isEnabled(): boolean {
    try {
      return this.options.enabled?.() ?? true;
    } catch {
      return true;
    }
  }

  /**
   * Perform an action on the problem on screen, as its button would, for example from a slash
   * command. Returns false when no problem is shown or the action is not offered.
   */
  act(action: ProblemAction): boolean {
    try {
      const entry = this.current;
      const ui = this.ui;
      if (!entry || !ui) return false;
      if (action === "disable" && !this.options.disable) return false;
      this.perform(action, entry, ui);
      return true;
    } catch {
      return false;
    }
  }

  private display(entry: Shown): void {
    const ui = this.ui;
    if (!ui) return;
    this.current = entry;
    const report = problemReport(this.source, entry.problem);
    entry.report = report;
    // A terminal from an earlier UI is gone; the widget factory supplies the current one.
    entry.tui = undefined;
    const disable = this.options.disable !== undefined;
    const actions: { action: ProblemAction; label: string }[] = [
      { action: "open", label: "[Open issue]" },
      { action: "copy", label: "[Copy report]" },
      ...(disable ? [{ action: "disable" as const, label: "[Don't show again]" }] : []),
      { action: "close", label: "[Close]" },
    ];
    const command = this.options.command;
    const hint = command
      ? `Without a mouse: /${command} open, copy${disable ? ", off" : ""} or close.`
      : undefined;
    try {
      ui.setWidget(this.widgetKey, (tui, theme) => {
        entry.tui = tui;
        return guardComponent(
          new ProblemPanel(
            this.source,
            entry.problem,
            report,
            theme,
            actions,
            (action) => {
              try {
                this.perform(action, entry, ui);
              } catch {
                // A failed button must not end Pi.
              }
            },
            hint,
          ),
          () => {},
        );
      });
    } catch {
      // Try again with the next UI.
      this.current = undefined;
      this.queue.unshift(entry);
    }
  }

  private perform(action: ProblemAction, entry: Shown, ui: ProblemUi): void {
    const report = entry.report ?? problemReport(this.source, entry.problem);
    if (action === "close") {
      this.closed.add(entry.key);
      this.dismiss(entry);
      return;
    }
    if (action === "disable") {
      this.queue.length = 0;
      this.dismiss(entry);
      void this.disableReports(ui);
      return;
    }
    if (action === "open") {
      const tui = entry.tui;
      const open = tui === undefined ? undefined : (tui as { openUrl?: unknown }).openUrl;
      if (typeof open === "function") {
        try {
          open.call(tui, report.url);
          return;
        } catch {
          // Fall back to copying the link.
        }
      }
      this.copyText(ui, report.url, "Issue link copied to the clipboard.", "issue link");
      return;
    }
    this.copyText(ui, report.body, "Problem report copied to the clipboard.", "problem report");
  }

  private async disableReports(ui: ProblemUi) {
    try {
      await this.options.disable?.();
    } catch (error) {
      notify(ui, `Could not turn problem reports off: ${errorMessage(error)}`, "error");
      return;
    }
    notify(
      ui,
      this.options.disabledNotice ?? `${this.source.name} problem reports are off.`,
      "info",
    );
  }

  private copyText(ui: ProblemUi, text: string, done: string, what: string): void {
    void this.copyAndNotify(ui, text, done, what);
  }

  private async copyAndNotify(ui: ProblemUi, text: string, done: string, what: string) {
    try {
      await this.copy(text);
    } catch (error) {
      notify(ui, `Could not copy the ${what}: ${errorMessage(error)}`, "error");
      return;
    }
    notify(ui, done, "info");
  }

  private dismiss(entry: { key: string }): void {
    if (this.current?.key !== entry.key) return;
    this.current = undefined;
    this.clearWidget();
    this.refresh();
  }

  private clearWidget(): void {
    try {
      this.ui?.setWidget(this.widgetKey, undefined);
    } catch {
      // The UI may already be gone.
    }
  }
}
