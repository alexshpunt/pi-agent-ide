import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { COMPACT_READ_ROWS } from "#src/extensions/pi-agent-read/src/core/tools/read/read-renderer.js";
import type {
  ShellProfile,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

type TerminalTheme = Pick<Theme, "fg">;

/** Render a stable shell prompt for a run tool call. */
export function renderRunCall(
  command: string,
  background: boolean,
  cwd: string,
  profile: ShellProfile,
  theme: TerminalTheme,
): Component {
  const mode = background ? "background" : "wait";
  const heading = `${theme.fg("toolTitle", profile.displayName.toLocaleLowerCase())} ${theme.fg("muted", `· ${shortCwd(cwd)} · ${mode}`)}`;
  return new Text(
    `${heading}\n${theme.fg("accent", promptMarker(profile.family))} ${command}`,
    0,
    0,
  );
}

/** Render only the outcome below an already-visible terminal action call. */
export function renderTerminalActionResult(
  action: "write" | "insert" | "delete",
  changedLines: readonly string[],
  theme: TerminalTheme,
): Component {
  const lines = changedLines.map((line) => `  ${theme.fg("dim", line)}`);
  lines.push(theme.fg("success", action === "delete" ? "✓ stopped" : "✓ sent"));
  return new Text(lines.join("\n"), 0, 0);
}

/** Render a terminal resource action without exposing its internal shell address. */
export function renderTerminalAction(
  snapshot: Partial<TerminalSessionSnapshot>,
  action: "read" | "write" | "insert" | "delete" | "search",
  value: string,
  changedLines: readonly string[],
  theme: TerminalTheme,
): Component {
  const lines = [terminalIdentity(snapshot, theme), theme.fg("accent", `${action} ${value}`)];
  if (changedLines.length > 0)
    lines.push(...changedLines.map((line) => `  ${theme.fg("dim", line)}`));
  return new Text(lines.join("\n"), 0, 0);
}
/** Render a terminal result as a compact or expanded pseudo-terminal card. */
export function renderTerminalResult(
  snapshot: Partial<TerminalSessionSnapshot>,
  expanded: boolean,
  theme: TerminalTheme,
  action?: string,
): Component {
  const lines = terminalCardLines(
    snapshot,
    expanded ? Number.POSITIVE_INFINITY : COMPACT_READ_ROWS,
    theme,
  );
  if (action !== undefined) lines.splice(1, 1, theme.fg("accent", action));
  return new Text(lines.join("\n"), 0, 0);
}

/** Render the result beneath the already-visible run prompt without repeating the command. */
export function renderRunResult(
  snapshot: Partial<TerminalSessionSnapshot>,
  expanded: boolean,
  theme: TerminalTheme,
): Component {
  if (expanded) return renderTerminalResult(snapshot, true, theme);
  const window = outputWindow(snapshot.output ?? "", COMPACT_READ_ROWS);
  const lines = [
    ...(window.omitted > 0 ? [`  ${theme.fg("muted", `… ${window.omitted} earlier lines`)}`] : []),
    ...window.lines.map((line) => `  ${theme.fg("dim", line)}`),
  ];
  lines.push(statusLine(snapshot, (name, text) => theme.fg(name, text)));
  return new Text(lines.join("\n"), 0, 0);
}
/** Render one live below-editor mini-card with changing state only at its tail. */
export function renderActiveTerminal(
  snapshot: TerminalSessionSnapshot,
  theme?: TerminalTheme,
): string {
  const color = (name: ThemeColor, text: string): string => theme?.fg(name, text) ?? text;
  const heading = `${color("accent", snapshot.shell.toLocaleLowerCase())} ${color("muted", `· ${shortCwd(snapshot.cwd)} · ${snapshot.background ? "background" : "wait"}`)}`;
  const lines = [
    heading,
    `${color("accent", promptMarker(snapshot.shellFamily))} ${oneLine(snapshot.command, 84)}`,
  ];
  const tail = outputTail(snapshot.output, 2);
  if (tail.length > 0) lines.push(...tail.map((line) => `  ${color("dim", oneLine(line, 90))}`));
  lines.push(statusLine(snapshot, color));
  return lines.join("\n");
}

/** Build a concise completion or result card from immutable session data. */
export function terminalCardLines(
  snapshot: Partial<TerminalSessionSnapshot>,
  outputLines: number,
  theme: TerminalTheme,
): string[] {
  const shell = (snapshot.shell ?? "terminal").toLocaleLowerCase();
  const mode = snapshot.background === true ? "background" : "wait";
  const cwd = snapshot.cwd === undefined ? "workspace" : shortCwd(snapshot.cwd);
  const family = snapshot.shellFamily ?? "posix";
  const lines = [
    `${theme.fg("accent", shell)} ${theme.fg("muted", `· ${cwd} · ${mode}`)}`,
    `${theme.fg("accent", promptMarker(family))} ${snapshot.command ?? ""}`,
  ];
  const window = outputWindow(snapshot.output ?? "", outputLines);
  if (window.omitted > 0) lines.push(`  ${theme.fg("muted", `… ${window.omitted} earlier lines`)}`);
  if (window.lines.length > 0)
    lines.push(...window.lines.map((line) => `  ${theme.fg("dim", line)}`));
  lines.push(statusLine(snapshot, (name, text) => theme.fg(name, text)));
  return lines;
}

/** Render bordered mini-cards modeled after the Herdr subagent activity widget. */
export function renderTerminalWidgetLines(
  snapshots: readonly TerminalSessionSnapshot[],
  width: number,
  theme: TerminalTheme,
): string[] {
  if (snapshots.length === 0) return [];
  const accent = (text: string): string => theme.fg("accent", text);
  const lines = [borderTop("Terminals", `${snapshots.length} active`, width, accent)];
  for (const snapshot of snapshots) {
    const card = renderActiveTerminal(snapshot, theme).split("\n");
    for (const line of card) lines.push(borderLine(` ${line} `, width, accent));
    if (snapshot !== snapshots.at(-1)) lines.push(borderLine("", width, accent));
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
export function outputTail(output: string, count: number): readonly string[] {
  return outputWindow(output, count).lines;
}

function outputWindow(
  output: string,
  count: number,
): { readonly lines: readonly string[]; readonly omitted: number } {
  const lines = stripVTControlCharacters(output)
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trimEnd());
  if (lines.at(-1) === "") lines.pop();
  const limit = Number.isFinite(count) ? Math.max(0, count) : lines.length;
  const omitted = Math.max(0, lines.length - limit);
  return { lines: lines.slice(omitted), omitted };
}

function statusLine(
  snapshot: Partial<TerminalSessionSnapshot>,
  color: (name: ThemeColor, text: string) => string,
): string {
  const status = snapshot.status ?? "running";
  const icon = statusIcon(status);
  const tone: ThemeColor =
    status === "completed" ? "success" : status === "running" ? "accent" : "error";
  const parts = [`${icon} ${status}`, formatElapsed(snapshot.elapsedMs ?? 0)];
  if (snapshot.exitCode !== undefined) parts.push(`exit ${snapshot.exitCode}`);
  else if (snapshot.signal !== undefined) parts.push(`signal ${snapshot.signal}`);
  return color(tone, parts.join(" · "));
}

function statusIcon(status: TerminalSessionStatus): string {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "stopping") return "◌";
  return "✗";
}

function promptMarker(family: ShellProfile["family"]): string {
  return family === "powershell" ? "PS>" : family === "cmd" ? ">" : "$";
}

function terminalIdentity(
  snapshot: Partial<TerminalSessionSnapshot>,
  theme: TerminalTheme,
): string {
  const shell = (snapshot.shell ?? "terminal").toLocaleLowerCase();
  const cwd = snapshot.cwd === undefined ? "workspace" : shortCwd(snapshot.cwd);
  const mode = snapshot.background === true ? "background" : "wait";
  const command = oneLine(snapshot.command ?? "process", 48);
  return `${theme.fg("toolTitle", shell)} ${theme.fg("muted", `· ${cwd} · ${mode} · ${command}`)}`;
}
function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home !== undefined && (cwd === home || cwd.startsWith(`${home}${path.sep}`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function oneLine(value: string, max: number): string {
  const line = value.replaceAll(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}
