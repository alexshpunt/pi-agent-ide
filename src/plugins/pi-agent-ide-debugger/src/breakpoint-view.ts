import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TextLinePresenter } from "pi-agent-text";

import type {
  DebugBreakpoint,
  DebugSessionManager,
} from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

/** Annotate source lines with breakpoints from current debug sessions. */
export function createBreakpointPresenter(manager: DebugSessionManager): TextLinePresenter {
  return {
    id: "debug-breakpoints",
    present(document, context) {
      const debugSession = manager.get(context.source);
      const sourceFile =
        manager.sourceFile(context.source) ??
        filesystemSource(context.source, context.cwd) ??
        filesystemSource(document.source, context.cwd);
      if (sourceFile === undefined) return document;
      const breakpoints = manager.breakpointsForFile(sourceFile, debugSession?.source);
      if (breakpoints.length === 0) return document;
      const byLine = groupByLine(breakpoints);
      return {
        ...document,
        lines: document.lines.map((line) => {
          const matches = byLine.get(line.lineNumber);
          if (matches === undefined) return line;
          return {
            ...line,
            presentation: {
              ...line.presentation,
              suffix: `${line.presentation?.suffix ?? ""}${renderAgentBreakpoints(matches)}`,
              compactSuffix: `${line.presentation?.compactSuffix ?? ""}${renderUserBreakpoints(matches)}`,
            },
          };
        }),
      };
    },
  };
}

function groupByLine(
  breakpoints: readonly DebugBreakpoint[],
): ReadonlyMap<number, readonly DebugBreakpoint[]> {
  const grouped = new Map<number, DebugBreakpoint[]>();
  for (const breakpoint of breakpoints) {
    const line = grouped.get(breakpoint.line) ?? [];
    line.push(breakpoint);
    grouped.set(breakpoint.line, line);
  }
  return grouped;
}
function filesystemSource(source: string, cwd: string): string | undefined {
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (/^[a-z][a-z\d+.-]*:/iu.test(source)) return undefined;
  return path.resolve(cwd, source);
}

function renderAgentBreakpoints(breakpoints: readonly DebugBreakpoint[]): string {
  return breakpoints
    .map(
      (breakpoint) =>
        `  ${breakpoint.verified ? "●" : "○"} breakpoint ${breakpoint.source} (${breakpoint.verified ? "verified" : "pending"})`,
    )
    .join("");
}

function renderUserBreakpoints(breakpoints: readonly DebugBreakpoint[]): string {
  const verified = breakpoints.filter((breakpoint) => breakpoint.verified).length;
  const marker = verified === breakpoints.length ? "●" : "○";
  const count = breakpoints.length === 1 ? "breakpoint" : `${breakpoints.length} breakpoints`;
  return `  ${marker} ${count}`;
}
