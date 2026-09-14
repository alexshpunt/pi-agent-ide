import { Box, Container } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { renderTerminalResult } from "#src/plugins/pi-agent-ide-terminal/src/renderer.js";
import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";
import type {
  TerminalSession,
  TerminalSessionSnapshot,
} from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const COMPLETION_DELAY_MS = 120;
const DEFAULT_STALE_INTERVAL_MS = 120_000;

/** Delivers background terminal completion messages separately from the shared process UI. */
export class TerminalUi {
  readonly #pending = new Map<string, TerminalSession>();
  #deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #overdue = new Set<string>();
  #context: ExtensionContext | undefined;
  #closed = false;
  readonly #removeManagerListeners: readonly (() => void)[];

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly manager: TerminalSessionManager,
    private readonly staleIntervalMs = DEFAULT_STALE_INTERVAL_MS,
  ) {
    pi.registerMessageRenderer("terminal-stale", (message, { expanded }, theme) => {
      const snapshot = isTerminalSessionSnapshot(message.details) ? message.details : undefined;
      const content = new Container();
      if (snapshot !== undefined)
        content.addChild(
          renderTerminalResult(snapshot, expanded, theme, "stale · inspect session"),
        );
      const card = new Box(1, 1, (line) => theme.bg("toolPendingBg", line));
      card.addChild(content);
      return card;
    });
    pi.registerMessageRenderer("terminal-completion", (message, { expanded }, theme) => {
      const content = new Container();
      for (const session of completionSnapshots(message.details))
        content.addChild(renderTerminalResult(session, expanded, theme));
      const card = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
      card.addChild(content);
      return card;
    });
    this.#removeManagerListeners = [
      manager.onDidChange((session) => this.#refreshStaleTimer(session)),
      manager.onDidComplete((session) => {
        this.#clearStaleTimer(session.id);
        if (session.background) this.#queueCompletion(session);
      }),
    ];
  }

  bind(context: ExtensionContext): void {
    this.#context = context;
  }

  /** Deliver deferred stale notices after Pi has fully settled. */
  onAgentSettled(context: ExtensionContext): void {
    this.#context = context;
    for (const id of [...this.#overdue]) {
      this.#overdue.delete(id);
      const session = this.manager.get(id);
      if (session !== undefined) this.#refreshStaleTimer(session, true);
    }
  }

  /** Notify the agent when an aborted tool result may no longer be deliverable. */
  notifyWaitTransition(session: TerminalSession): void {
    const snapshot = this.manager.snapshot(session);
    this.pi.sendMessage(
      {
        customType: "terminal-wait-transition",
        display: false,
        content: `Terminal wait aborted; ${snapshot.source} is still running in background. Read it to inspect output, then use write or insert to send input.`,
        details: snapshot,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  dispose(): void {
    this.#closed = true;
    if (this.#deliveryTimer !== undefined) clearTimeout(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    this.#pending.clear();
    for (const timer of this.#staleTimers.values()) clearTimeout(timer);
    this.#staleTimers.clear();
    this.#overdue.clear();
    this.#context = undefined;
    for (const removeListener of this.#removeManagerListeners) removeListener();
  }

  #refreshStaleTimer(session: TerminalSession, checkNow = false): void {
    this.#clearStaleTimer(session.id);
    if (this.#closed || !session.background || session.status !== "running") return;
    const snapshot = this.manager.snapshot(session);
    const remaining = Math.max(0, this.staleIntervalMs - snapshot.idleMs);
    if (checkNow && remaining === 0) {
      this.#handleStale(session);
      return;
    }
    this.#staleTimers.set(
      session.id,
      setTimeout(() => this.#handleStale(session), remaining),
    );
  }

  #handleStale(session: TerminalSession): void {
    this.#staleTimers.delete(session.id);
    if (this.#closed || session.status !== "running" || !session.background) return;
    if (this.#context?.isIdle() !== true) {
      this.#overdue.add(session.id);
      return;
    }
    const snapshot = this.manager.snapshot(session);
    this.pi.sendMessage(
      {
        customType: "terminal-stale",
        display: true,
        content: formatStaleMessage(snapshot),
        details: snapshot,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    this.#staleTimers.set(
      session.id,
      setTimeout(() => this.#handleStale(session), this.staleIntervalMs),
    );
  }

  #clearStaleTimer(id: string): void {
    const timer = this.#staleTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#staleTimers.delete(id);
    this.#overdue.delete(id);
  }

  #queueCompletion(session: TerminalSession): void {
    if (this.#closed || session.completionDelivered) return;
    this.#pending.set(session.id, session);
    if (this.#deliveryTimer !== undefined) return;
    this.#deliveryTimer = setTimeout(() => {
      this.#deliveryTimer = undefined;
      const sessions = [...this.#pending.values()].filter(
        (candidate) => !candidate.completionDelivered,
      );
      this.#pending.clear();
      if (this.#closed || sessions.length === 0) return;
      for (const completed of sessions) completed.completionDelivered = true;
      const snapshots = sessions.map((completed) => this.manager.snapshot(completed));
      this.pi.sendMessage(
        {
          customType: "terminal-completion",
          display: true,
          content: formatCompletionMessage(snapshots),
          details: { sessions: snapshots },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }, COMPLETION_DELAY_MS);
  }
}

function completionSnapshots(details: unknown): readonly TerminalSessionSnapshot[] {
  if (!isRecord(details) || !Array.isArray(details.sessions)) return [];
  return details.sessions.filter(isTerminalSessionSnapshot);
}
function isTerminalSessionSnapshot(value: unknown): value is TerminalSessionSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    typeof value.shell === "string" &&
    typeof value.background === "boolean" &&
    typeof value.status === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.elapsedMs === "number" &&
    typeof value.output === "string"
  );
}
function formatCompletionMessage(sessions: readonly TerminalSessionSnapshot[]): string {
  const heading =
    sessions.length === 1 ? "Background terminal completed:" : "Background terminals completed:";
  return `${heading}\n${sessions
    .map((session) => {
      const exit = session.exitCode === undefined ? "" : `, exit ${session.exitCode}`;
      const reason =
        session.completionReason === undefined ? "" : `, reason ${session.completionReason}`;
      const excerpt = session.output.trimEnd().slice(-2_000);
      return `- ${session.source}: ${session.status}${exit}${reason}, ${formatElapsed(session.elapsedMs)}\n${excerpt || "(no output)"}`;
    })
    .join("\n")}`;
}
function formatStaleMessage(session: TerminalSessionSnapshot): string {
  const excerpt = session.output.trimEnd().slice(-2_000);
  return `Background terminal ${session.source} has produced no output for ${formatElapsed(session.idleMs)}. Inspect it with read. If it is healthy, keep waiting; otherwise send input or stop it.\n${excerpt || "(no output)"}`;
}

function formatElapsed(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
