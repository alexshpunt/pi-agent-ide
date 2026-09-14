import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

/** Keep the useful end of terminal output within the shared Read output budget. */
export function terminalOutputTail(output: string): TruncationResult {
  return truncateTail(output, {
    maxBytes: DEFAULT_MAX_BYTES - 4_096,
    maxLines: DEFAULT_MAX_LINES - 32,
  });
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
    snapshot.waitReason === undefined
      ? undefined
      : `next: Read ${snapshot.source} to inspect it, then use write or insert to send input.`,
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
