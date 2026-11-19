import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.ts";

/** Keep the useful end of terminal output within the shared Read output budget. */
export function terminalOutputTail(output: string): TruncationResult {
  return truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES - 4_096,
    maxLines: DEFAULT_MAX_LINES - 32,
  });
}

/** Characters of trailing output that a terminal notice shows the agent and stores in the session. */
export const NOTICE_OUTPUT_CHARS = 2_000;

/**
 * Bound a snapshot that is persisted in the session by a terminal notice.
 *
 * The session keeps only the excerpt the agent saw; the complete output stays in the log file at
 * `fullOutputPath`. `outputStart`, `outputEnd` and `truncated` describe the stored excerpt.
 */
export function noticeSnapshot(snapshot: TerminalSessionSnapshot): TerminalSessionSnapshot {
  const end = snapshot.output.trimEnd().length;
  const start = Math.max(0, end - NOTICE_OUTPUT_CHARS);
  if (start === 0 && end === snapshot.output.length) return snapshot;
  return {
    ...snapshot,
    output: snapshot.output.slice(start, end),
    outputStart: snapshot.outputStart + start,
    outputEnd: snapshot.outputStart + end,
    truncated: snapshot.truncated || start > 0,
  };
}

/** Format one terminal snapshot for the agent without exposing unbounded output. */
export function formatAgentTerminalSnapshot(snapshot: TerminalSessionSnapshot): string {
  const truncation = terminalOutputTail(snapshot.output);
  const metadata = [
    `session: ${snapshot.source}`,
    `status: ${snapshot.status}`,
    `shell: ${snapshot.shell}`,
    `cwd: ${snapshot.cwd}`,
    `elapsedMs: ${snapshot.elapsedMs}`,
    snapshot.exitCode === undefined ? undefined : `exitCode: ${snapshot.exitCode}`,
    snapshot.signal === undefined ? undefined : `signal: ${snapshot.signal}`,
    snapshot.error === undefined ? undefined : `error: ${snapshot.error}`,
    snapshot.waitReason === undefined ? undefined : `reason: ${snapshot.waitReason}`,
    snapshot.completionReason === undefined
      ? undefined
      : `completionReason: ${snapshot.completionReason}`,
    snapshot.status === "running" && snapshot.background
      ? `next: Continue independent work or finish your turn; completion or a one-time idle inspection notice will wake the agent. Read ${snapshot.source} to inspect output; use write or insert when input is needed.`
      : undefined,
    `outputRange: ${snapshot.outputStart}-${snapshot.outputEnd}`,
    snapshot.truncated ? "retainedOutput: earlier data omitted from memory" : undefined,
    truncation.truncated ? `fullOutput: ${snapshot.fullOutputPath}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const output = truncation.content.trimEnd();
  if (!truncation.truncated) {
    return `${metadata.join("\n")}\noutput:${output.length === 0 ? " (empty)" : `\n${output}`}`;
  }
  const limit =
    truncation.truncatedBy === "lines"
      ? `${DEFAULT_MAX_LINES} line output budget`
      : `${formatSize(DEFAULT_MAX_BYTES)} output budget`;
  const notice = `[Earlier output omitted: showing the last ${truncation.outputLines} of ${truncation.totalLines} lines (${limit}). Full output: ${snapshot.fullOutputPath}]`;
  return `${metadata.join("\n")}\noutput:\n${notice}${output.length === 0 ? "" : `\n${output}`}`;
}
