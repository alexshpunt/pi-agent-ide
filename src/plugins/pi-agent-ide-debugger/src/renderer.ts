import path from "node:path";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type {
  DebugEvaluation,
  DebugSessionSnapshot,
  DebugSessionStatus,
  DebugStop,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

type DebugTheme = Pick<Theme, "fg">;

/** Render debugger creation without exposing its implementation tool syntax. */
export function renderDebugCall(
  adapter: string,
  program: string,
  cwd: string,
  theme: DebugTheme,
): Component {
  return new Text(
    `${theme.fg("toolTitle", adapter)} ${theme.fg("muted", `· ${shortPath(program, cwd)}`)}\n${theme.fg("accent", "◆ configure debugger")}`,
    0,
    0,
  );
}

/** Render a debugger action under one stable session identity. */
export function renderDebugActionCall(
  snapshot: DebugSessionSnapshot,
  action: string,
  theme: DebugTheme,
): Component {
  return new Text(
    `${debugIdentity(snapshot, theme)}\n${theme.fg("accent", actionLabel(action))}`,
    0,
    0,
  );
}

/** Render the state reached by a debugger action. */
export function renderDebugResult(
  snapshot: DebugSessionSnapshot,
  expanded: boolean,
  theme: DebugTheme,
  evaluation?: DebugEvaluation,
): Component {
  const lines = debugResultLines(snapshot, expanded, theme);
  if (evaluation !== undefined) {
    lines.unshift(
      `${theme.fg("accent", evaluation.expression)} ${theme.fg("muted", "=")} ${theme.fg("toolOutput", evaluation.result)}${evaluation.type === undefined ? "" : theme.fg("dim", `  ${evaluation.type}`)}`,
    );
  }
  return new Text(lines.join("\n"), 0, 0);
}

/** Render one compact live session for the below-editor activity widget. */
export function renderActiveDebugger(
  snapshot: DebugSessionSnapshot,
  theme: DebugTheme,
): readonly string[] {
  const lines = [debugIdentity(snapshot, theme), statusLine(snapshot.status, theme)];
  if (snapshot.stop?.frame !== undefined) {
    lines.push(
      `  ${theme.fg("warning", "●")} ${snapshot.stop.frame.name} ${theme.fg("muted", `· ${shortFrame(snapshot.stop)}`)}`,
    );
  }
  return lines;
}

function debugResultLines(
  snapshot: DebugSessionSnapshot,
  expanded: boolean,
  theme: DebugTheme,
): string[] {
  const lines: string[] = [];
  if (snapshot.status === "stopped" && snapshot.stop !== undefined) {
    lines.push(
      theme.fg("warning", `● stopped · ${snapshot.stop.reason}`),
      theme.fg(
        "text",
        `${snapshot.stop.frame?.name ?? "unknown frame"} ${theme.fg("muted", `· ${shortFrame(snapshot.stop)}`)}`,
      ),
    );
    for (const sourceLine of snapshot.stop.sourceLines) {
      const marker = sourceLine.current ? theme.fg("warning", ">") : theme.fg("dim", "│");
      const tone: ThemeColor = sourceLine.current ? "text" : "dim";
      lines.push(
        `${marker} ${String(sourceLine.lineNumber).padStart(4)} ${theme.fg(tone, sourceLine.content)}`,
      );
    }
    const variables = expanded ? snapshot.stop.variables : snapshot.stop.variables.slice(0, 6);
    if (variables.length > 0) {
      lines.push(theme.fg("muted", "Locals"));
      for (const variable of variables) {
        lines.push(
          `  ${theme.fg("accent", variable.name.padEnd(16))} ${theme.fg("toolOutput", variable.value)}${variable.type === undefined ? "" : theme.fg("dim", `  ${variable.type}`)}`,
        );
      }
      if (variables.length < snapshot.stop.variables.length) {
        lines.push(
          theme.fg("muted", `  … ${snapshot.stop.variables.length - variables.length} more`),
        );
      }
    }
    return lines;
  }
  lines.push(statusLine(snapshot.status, theme));
  if (snapshot.breakpoints.length > 0) {
    const verified = snapshot.breakpoints.filter((breakpoint) => breakpoint.verified).length;
    lines.push(
      theme.fg(
        "muted",
        `${snapshot.breakpoints.length} breakpoint${snapshot.breakpoints.length === 1 ? "" : "s"} · ${verified} verified`,
      ),
    );
  }
  return lines;
}

function debugIdentity(snapshot: DebugSessionSnapshot, theme: DebugTheme): string {
  return `${theme.fg("toolTitle", snapshot.options.adapter)} ${theme.fg("muted", `· ${shortPath(snapshot.options.program, snapshot.options.cwd)}`)}`;
}

function actionLabel(action: string): string {
  const normalized = action.trim().toLowerCase();
  if (normalized === "start") return "▶ start debugging";
  if (normalized === "continue") return "▶ continue";
  if (normalized === "step over") return "↷ step over";
  if (normalized === "step into") return "↓ step into";
  if (normalized === "step out") return "↑ step out";
  if (normalized.startsWith("evaluate ")) return `◆ ${action.trim().slice("evaluate ".length)}`;
  if (normalized.startsWith("breakpoint ")) return `● add ${normalized}`;
  if (normalized.startsWith("delete-breakpoint ")) {
    return `○ remove breakpoint · ${normalized.slice("delete-breakpoint ".length)}`;
  }
  if (normalized === "breakpoint") return "● add breakpoint";
  if (normalized === "delete-breakpoint") return "○ remove breakpoint";
  if (normalized === "delete-session") return "■ stop debugging";
  return normalized;
}

function statusLine(status: DebugSessionStatus, theme: DebugTheme): string {
  if (status === "configured") return theme.fg("muted", "◇ ready");
  if (status === "running") return theme.fg("accent", "● running");
  if (status === "stopped") return theme.fg("warning", "● stopped");
  return theme.fg("success", "■ stopped debugging");
}

function shortFrame(stop: DebugStop): string {
  const source = stop.frame?.source?.path ?? stop.frame?.source?.name ?? "unknown";
  return `${path.basename(source)}:${stop.frame?.line ?? "?"}`;
}

function shortPath(program: string, cwd: string): string {
  const relative = path.relative(cwd, program);
  const parent = ".".repeat(2);
  const outside = relative === parent || relative.startsWith(`${parent}${path.sep}`);
  return relative.length > 0 && !outside ? relative : path.basename(program);
}
