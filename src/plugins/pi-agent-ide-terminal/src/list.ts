import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.ts";

const LIST_HINT =
  "Read shell:<session> for its status and output. Search with path shell: to search all listed sessions.";

/** List terminal sessions for the agent: running sessions first, then the most recent. */
export function formatTerminalList(
  snapshots: readonly TerminalSessionSnapshot[],
  now = Date.now(),
): string {
  if (snapshots.length === 0) return "No terminal sessions in this Pi session.";
  const ordered = [...snapshots].sort(
    (left, right) =>
      Number(isActive(right)) - Number(isActive(left)) || right.startedAt - left.startedAt,
  );
  const running = ordered.filter(isActive).length;
  return [
    `Terminal sessions of this Pi session: ${ordered.length} (${running} running)`,
    ...ordered.map((snapshot) => formatEntry(snapshot, now)),
    LIST_HINT,
  ].join("\n");
}

/** Render a listing from its agent text, so a past result keeps showing the state it reported. */
export function renderTerminalList(
  result: { readonly content: readonly { readonly type: string; readonly text?: string }[] },
  theme: Pick<Theme, "fg">,
): Component {
  const text = result.content.find((block) => block.type === "text")?.text ?? "";
  const [heading = "", ...rest] = text.split("\n");
  const lines = [
    theme.fg("toolTitle", "terminal sessions"),
    theme.fg("muted", heading),
    ...rest
      .filter((line) => line !== LIST_HINT)
      .map((line) =>
        line.includes(" · running · ") || line.includes(" · stopping · ")
          ? `  ${theme.fg("accent", line)}`
          : `  ${theme.fg("dim", line)}`,
      ),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function formatEntry(snapshot: TerminalSessionSnapshot, now: number): string {
  const state = isActive(snapshot)
    ? `${snapshot.status} · last activity ${duration(now - snapshot.lastActivityAt)} ago`
    : [
        snapshot.status,
        snapshot.exitCode === undefined ? undefined : `exit ${snapshot.exitCode}`,
        snapshot.signal === undefined ? undefined : `signal ${snapshot.signal}`,
        `ended ${duration(now - (snapshot.endedAt ?? now))} ago`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · ");
  return [snapshot.source, state, snapshot.shell, snapshot.cwd, oneLine(snapshot.command)].join(
    " · ",
  );
}

function isActive(snapshot: TerminalSessionSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "stopping";
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function oneLine(command: string): string {
  const line = command.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}
