import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface TipContent {
  readonly title: string;
  readonly body: string;
}

const PRODUCT_LABEL = "PI AGENT IDE";
const COMMAND_PATTERN = /\/[a-z][\w-]*/giu;

/** Renders a startup tip as a compact, theme-aware callout with an accent rail. */
export class TipCallout implements Component {
  private cached: { readonly width: number; readonly lines: string[] } | undefined;

  public constructor(
    private readonly tip: TipContent,
    private readonly theme: Theme,
  ) {}

  public render(width: number): string[] {
    if (this.cached?.width === width) {
      return this.cached.lines;
    }

    const lines = renderTip(this.tip, this.theme, width);
    this.cached = { width, lines };
    return lines;
  }

  public invalidate(): void {
    this.cached = undefined;
  }
}

function renderTip(tip: TipContent, theme: Theme, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  if (width <= 2) {
    return [theme.fg("accent", width === 1 ? "│" : "│ ")];
  }

  const contentWidth = width - 2;
  const header =
    theme.fg("accent", theme.bold(PRODUCT_LABEL)) + theme.fg("dim", " · ") + theme.bold(tip.title);
  const body = tip.body
    .split("\n")
    .map((line) => (line.length === 0 ? "" : styleBodyLine(line, theme)));
  const contentLines = [header, ...body].flatMap((line) => wrapLine(line, contentWidth));
  const rail = theme.fg("accent", "│");
  const lines = contentLines.map((line) => truncateToWidth(`${rail} ${line}`, width));

  return lines;
}

function wrapLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }

  return wrapTextWithAnsi(line, width);
}

function styleBodyLine(line: string, theme: Theme): string {
  let result = "";
  let cursor = 0;

  for (const match of line.matchAll(COMMAND_PATTERN)) {
    const index = match.index;
    result += theme.fg("muted", line.slice(cursor, index));
    result += theme.fg("accent", theme.bold(match[0]));
    cursor = index + match[0].length;
  }

  return result + theme.fg("muted", line.slice(cursor));
}
