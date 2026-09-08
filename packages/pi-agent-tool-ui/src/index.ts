import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** One styled value in a compact tool-call header. */
export interface ToolCallHeaderPart {
  readonly text: string;
  readonly color?: ThemeColor;
  readonly bold?: boolean;
  readonly underline?: boolean;
  /** Keeps the start or end of this value when the terminal is narrow. */
  readonly truncate?: "start" | "end";
}

/** One exact tool argument shown when tool output is expanded. */
export interface ToolCallHeaderDetail {
  readonly label: string;
  readonly value: string;
}

/** Width-independent content for a tool-call header. */
export interface ToolCallHeaderModel {
  readonly tool: string;
  readonly primary?: ToolCallHeaderPart;
  /** Ordered from most to least important. */
  readonly qualifiers?: readonly ToolCallHeaderPart[];
  readonly details?: readonly ToolCallHeaderDetail[];
  readonly expanded: boolean;
}

/** Lifecycle state that selects Pi's enclosing tool-card background. */
export interface ToolBackgroundState {
  readonly isPartial: boolean;
  readonly isError: boolean;
}

/** Returns the ANSI background used by Pi's standard tool-card shell for this state. */
export function toolBackgroundAnsi(theme: Theme, state: ToolBackgroundState): string {
  return theme.getBgAnsi(
    state.isPartial ? "toolPendingBg" : state.isError ? "toolErrorBg" : "toolSuccessBg",
  );
}

/** A reusable, width-safe header for Pi tool cards. */
export class ToolCallHeader implements Component {
  private cache: { readonly width: number; readonly lines: readonly string[] } | undefined;

  public constructor(
    private model: ToolCallHeaderModel,
    private theme: Theme,
  ) {}

  /** Replaces the visible call state while retaining the component instance. */
  public update(model: ToolCallHeaderModel, theme: Theme): void {
    if (this.model === model && this.theme === theme) {
      return;
    }

    this.model = model;
    this.theme = theme;
    this.invalidate();
  }

  public render(width: number): string[] {
    if (this.cache?.width === width) {
      return [...this.cache.lines];
    }

    const lines = renderToolCallHeader(this.model, this.theme, width);
    this.cache = { width, lines };
    return [...lines];
  }

  public invalidate(): void {
    this.cache = undefined;
  }
}

/** Reuses the last compatible header component supplied by Pi. */
export function toolCallHeader(
  previous: Component | undefined,
  model: ToolCallHeaderModel,
  theme: Theme,
): ToolCallHeader {
  const component =
    previous instanceof ToolCallHeader ? previous : new ToolCallHeader(model, theme);
  component.update(model, theme);
  return component;
}

/** Renders one compact summary line and optional expanded exact arguments. */
export function renderToolCallHeader(
  model: ToolCallHeaderModel,
  theme: Theme,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const summary = renderSummary(model, theme, safeWidth);

  const details = model.details;
  if (!model.expanded || details === undefined || details.length === 0) {
    return [summary];
  }

  return [summary, ...renderToolCallDetails(details, theme, safeWidth)];
}

/** Renders exact tool arguments with shared wrapping and styling. */
export function renderToolCallDetails(
  details: readonly ToolCallHeaderDetail[],
  theme: Theme,
  width: number,
): string[] {
  if (details.length === 0) {
    return [];
  }

  const detail = [theme.fg("dim", "args ")]
    .concat(
      details.map(({ label, value }, index) => {
        const separator = index === 0 ? "" : theme.fg("dim", " · ");
        return `${separator}${theme.fg("muted", `${singleLine(label)}=`)}${theme.fg(
          "toolOutput",
          singleLine(value),
        )}`;
      }),
    )
    .join("");
  const safeWidth = Math.max(1, width);
  return wrapTextWithAnsi(detail, safeWidth).map((line) => truncateToWidth(line, safeWidth));
}

const SGR_SEQUENCE = /\u001B\[([\d:;]*)m/gu;

const SGR_AT_START = /^\u001B\[([\d:;]*)m/u;

type SgrBackgroundState = "unchanged" | "set" | "reset";

/**
 * Keeps a parent background active when nested ANSI styling resets it.
 *
 * Apply this to child output before the parent wraps the line in its background.
 */
export function preserveEnclosingBackground(text: string, backgroundAnsi: string): string {
  if (backgroundAnsi.length === 0) {
    return text;
  }

  return text.replace(
    SGR_SEQUENCE,
    (sequence, parameters: string, offset: number, source: string) =>
      sgrBackgroundState(parameters) === "reset" &&
      !backgroundIsImmediatelySet(source, offset + sequence.length)
        ? `${sequence}${backgroundAnsi}`
        : sequence,
  );
}

function backgroundIsImmediatelySet(source: string, offset: number): boolean {
  const next = SGR_AT_START.exec(source.slice(offset));
  return next !== null && sgrBackgroundState(next[1] ?? "") === "set";
}

function sgrBackgroundState(parameters: string): SgrBackgroundState {
  const values = parameters.length === 0 ? ["0"] : parameters.split(";");
  let state: SgrBackgroundState = "unchanged";

  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? "";
    const code = Number(value.split(":", 1)[0] || "0");

    if (code === 0 || code === 49) {
      state = "reset";
      continue;
    }

    if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state = "set";
      continue;
    }

    if (code !== 38 && code !== 48 && code !== 58) {
      continue;
    }

    if (code === 48) {
      state = "set";
    }
    if (value.includes(":")) {
      continue;
    }

    const mode = Number(values[index + 1]);
    index += mode === 2 ? 4 : mode === 5 ? 2 : 0;
  }

  return state;
}

/** Turns any runtime argument value into a safe single-line display value. */
export function singleLine(value: unknown): string {
  let output = "";
  const text = typeof value === "string" ? value : "";

  for (const character of text) {
    if (character === "\n") {
      output += "\\n";
      continue;
    }
    if (character === "\r") {
      output += "\\r";
      continue;
    }
    if (character === "\t") {
      output += "\\t";
      continue;
    }

    const code = character.codePointAt(0) ?? 0;
    output += code < 0x20 || code === 0x7f ? "�" : character;
  }

  return output;
}

function renderSummary(model: ToolCallHeaderModel, theme: Theme, width: number): string {
  const tool = theme.fg("toolTitle", theme.bold(singleLine(model.tool)));
  const toolWidth = visibleWidth(tool);

  if (toolWidth >= width || model.primary === undefined) {
    return truncateToWidth(tool, width);
  }

  const separator = theme.fg("dim", " · ");
  const qualifiers = [...(model.qualifiers ?? [])];
  let dropped = 0;

  while (
    qualifiers.length > 0 &&
    summaryWidth(tool, model.primary, qualifiers, dropped, theme) > width
  ) {
    qualifiers.pop();
    dropped++;
  }

  const qualifierWidth = qualifiers.reduce(
    (total, part) => total + visibleWidth(separator) + visibleWidth(renderPart(part, theme)),
    0,
  );
  const omitted = dropped === 0 ? "" : theme.fg("dim", ` · … +${String(dropped)}`);
  const primaryWidth = Math.max(1, width - toolWidth - 1 - qualifierWidth - visibleWidth(omitted));
  const primary = renderPart(
    {
      ...model.primary,
      text: truncatePart(singleLine(model.primary.text), primaryWidth, model.primary.truncate),
    },
    theme,
  );
  const renderedQualifiers = qualifiers
    .map((part) => `${separator}${renderPart(part, theme)}`)
    .join("");
  return truncateToWidth(`${tool} ${primary}${renderedQualifiers}${omitted}`, width);
}

function summaryWidth(
  tool: string,
  primary: ToolCallHeaderPart,
  qualifiers: readonly ToolCallHeaderPart[],
  dropped: number,
  theme: Theme,
): number {
  const qualifierWidth = qualifiers.reduce(
    (total, part) => total + 3 + visibleWidth(renderPart(part, theme)),
    0,
  );
  const omittedWidth = dropped === 0 ? 0 : visibleWidth(` · … +${String(dropped)}`);
  return (
    visibleWidth(tool) + 1 + visibleWidth(singleLine(primary.text)) + qualifierWidth + omittedWidth
  );
}

function renderPart(part: ToolCallHeaderPart, theme: Theme): string {
  let text = singleLine(part.text);

  if (part.bold === true) {
    text = theme.bold(text);
  }
  if (part.underline === true) {
    text = theme.underline(text);
  }

  return theme.fg(part.color ?? "muted", text);
}

function truncatePart(
  value: string,
  width: number,
  direction: "start" | "end" | undefined,
): string {
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return "…";
  }

  if (direction !== "start") {
    return truncateToWidth(value, width);
  }

  const tailWidth = width - 1;
  return `…${sliceByColumn(value, visibleWidth(value) - tailWidth, tailWidth, true)}`;
}
