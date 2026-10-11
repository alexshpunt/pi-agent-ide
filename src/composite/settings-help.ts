import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  ScrollView,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

/** Read the shipped human guide, independently of optional documentation modules. */
export function readSettingsHelp(): Promise<string> {
  return readFile(
    path.join(path.dirname(path.dirname(import.meta.dirname)), "docs/settings-help.md"),
    "utf8",
  );
}

/** Register local settings help without adding history, context or a model turn. */
export function registerSettingsHelp(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("agent-ide-help", {
    description: "Read the short Agent IDE settings guide",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      try {
        const content = await readSettingsHelp();
        await ctx.ui.custom<void>(
          (tui, theme, _keys, done) =>
            new SettingsHelpPanel(
              content,
              theme,
              () => Math.max(5, Math.min(36, tui.terminal.rows - 4)),
              () => tui.requestRender(),
              done,
            ),
          { overlay: true, overlayOptions: { width: 92, margin: 1 } },
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

/** A bounded Markdown viewport with keyboard scrolling and no persistent state. */
export class SettingsHelpPanel implements Component {
  private markdown: Markdown;
  private scroll: ScrollView;

  constructor(
    private readonly content: string,
    private readonly theme: Theme,
    private readonly height: () => number,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {
    this.markdown = this.createMarkdown();
    this.scroll = new ScrollView(this.markdown);
  }

  private createMarkdown(): Markdown {
    return new Markdown(this.content, 0, 0, getMarkdownTheme(), {
      color: (text) => this.theme.fg("text", text),
    });
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const rows = this.markdown.render(inner);
    const viewport = Math.max(1, this.height() - 4);
    this.scroll.updateLayout(rows.length, viewport, this.requestRender);
    const page = rows.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport);
    while (page.length < viewport) page.push("");
    const border = this.theme.fg("border", "─".repeat(Math.max(0, width - 2)));
    const row = (text: string) =>
      this.theme.fg("border", "│ ") +
      truncateToWidth(text, inner, "…", true) +
      this.theme.fg("border", " │");
    return [
      this.theme.fg("border", "╭") + border + this.theme.fg("border", "╮"),
      row(this.theme.fg("accent", "Agent IDE settings help")),
      ...page.map(row),
      row(this.theme.fg("muted", "↑↓ scroll · PgUp/PgDn page · Home/End · Esc close")),
      this.theme.fg("border", "╰") + border + this.theme.fg("border", "╯"),
    ];
  }
}
