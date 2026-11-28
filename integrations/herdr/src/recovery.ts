import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { agentStatusOf, clean, cut, oneLine } from "./timeline.ts";

const DELIVERY = "herdr-recovery";
const WAKE = "herdr-recovery-wake";
type Key = { id: string; revision: string };
type RecoveryItem = Key & {
  session: string;
  operation: string;
  toolCallId: string | null;
  state: "pending" | "result" | "unknown" | "error";
  recoverable?: boolean;
  result?: unknown;
  error?: unknown;
  evidence?: unknown;
};
type RecoveryApi = {
  list(): Promise<unknown>;
  ack(request: { items: Key[] }): Promise<void>;
};
type Bridge = { version: number; recovery?: RecoveryApi };
const key = (value: Key) => JSON.stringify([value.id, value.revision]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const isHerdr = (value: Record<string, unknown> | undefined, requireSource: boolean): boolean => {
  if (!value) return false;
  if (value.resolvedBy !== undefined && value.resolvedBy !== "herdr") return false;
  if (value.source === undefined) return !requireSource;
  return typeof value.source === "string" && value.source.startsWith("herdr:");
};
const isItem = (value: unknown): value is RecoveryItem => {
  const item = record(value);
  return (
    !!item &&
    typeof item.id === "string" &&
    typeof item.revision === "string" &&
    typeof item.session === "string" &&
    typeof item.operation === "string" &&
    (item.state === "unknown" ||
      (item.state === "result" && "result" in item) ||
      (item.state === "error" && "error" in item))
  );
};

const addressOf = (value: unknown): string | undefined => {
  const terminal = record(value)?.terminal;
  return typeof terminal === "string" && /^(?:[^\s/:#]+\/)?t[a-zA-Z0-9]+$/u.test(terminal)
    ? `herdr:${terminal}`
    : undefined;
};
const actionName: Record<string, string> = {
  "agent.send": "message",
  "agent.remove": "agent closure",
  "agent.replicate": "replica launch",
  "agent.subagent": "sub-agent launch",
};
/** Avoid injecting raw tool payloads, logs, code, or stack traces into a recovery notice. */
function proseExcerpt(
  value: unknown,
  limit: number,
): { text?: string; incomplete: boolean } | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = clean(value).trim();
  if (!text) return undefined;
  const raw =
    /```|^\s*(?:[[{]|Traceback \(most recent call last\)|at\s+\S+.*:\d+:\d+|File "[^"]+", line \d+|\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d|(?:INFO|WARN|ERROR|DEBUG|TRACE)\s*[:[])/mu.test(
      text,
    ) || /"[\w.-]+"\s*:\s*(?:"|[{[\d]|true\b|false\b|null\b)/u.test(text);
  if (raw) return { incomplete: true };
  return { text: cut(text, limit), incomplete: text.length > limit };
}

/** Present only the outcome and what the agent can do with it. Receipts stay in details. */
function describeOutcome(item: RecoveryItem): string {
  const result = record(item.result);
  const source = addressOf(item.result);
  const readOnly = ["agent.list", "agent.inspect", "agent.history", "workflow.get"].includes(
    item.operation,
  );
  const related = Array.isArray(item.evidence)
    ? item.evidence.map((entry) => addressOf(record(entry)?.result)).find(Boolean)
    : undefined;
  const uncertain = (target?: string) =>
    readOnly
      ? "An interrupted Herdr read has no confirmed result. Repeat the read."
      : `The interrupted ${actionName[item.operation] ?? "Herdr action"} may have taken effect. ${target ? `Read ${target}` : "Read herdr:"} before retrying.`;
  if (item.state === "unknown") return uncertain(related);
  if (item.state === "error" && record(item.error)?.effect !== "not-applied")
    return uncertain(related);
  if (item.state === "error") {
    const reason = record(item.error)?.reason;
    const guidance =
      reason === "queue"
        ? "Wait for other Herdr requests to finish, then retry."
        : reason === "app-version"
          ? "Update Herdr App and reload Pi before retrying."
          : reason === "storage"
            ? "Check recovery storage and available space before retrying."
            : "Read herdr: to check the situation before retrying.";
    return `The ${actionName[item.operation] ?? "Herdr request"} was not submitted. ${guidance}`;
  }
  if (typeof result?.error === "string") {
    if (result.effect === "not-applied")
      return "The Herdr request was refused before it took effect. Read herdr: to check the situation before retrying.";
    return `The Herdr request failed and may have taken effect. ${source ? `Read ${source}` : "Inspect Herdr"} before retrying.`;
  }
  if (item.operation === "agent.list" && Array.isArray(result?.agents)) {
    const agents = result.agents.map((entry: unknown) => {
      const agent = record(entry),
        address = addressOf(entry);
      if (!agent || !address) return undefined;
      const name = typeof agent.name === "string" ? oneLine(agent.name) : "Agent";
      const status =
        typeof agent.state === "string"
          ? agentStatusOf({
              state: agent.state,
              status: typeof agent.status === "string" ? agent.status : undefined,
              exited: agent.exited === true,
            })
          : undefined;
      return `${name || "Agent"} at ${address}${status ? ` is ${status}` : ""}.`;
    });
    if (agents.some((agent: unknown) => !agent))
      return "The recovered agent list was incomplete. Read herdr: again.";
    return agents.length ? agents.join("\n") : "There are no Pi agents in Herdr.";
  }
  const inspection = record(result?.inspection);
  if (item.operation === "agent.inspect" && source && inspection) {
    if (typeof inspection.busy !== "boolean")
      return `The recovered inspection was incomplete. Read ${source} again.`;
    const status =
      result?.exited === true || result?.state === "exited" || result?.status === "exited"
        ? "exited"
        : inspection.pendingQuestion
          ? "waiting for an answer"
          : inspection.busy
            ? "working"
            : inspection.failed
              ? "in error"
              : "idle";
    const question = proseExcerpt(inspection.pendingQuestion, 300);
    const events = Array.isArray(inspection.events) ? inspection.events : [];
    const reply = events
      .map(record)
      .findLast((event) => event?.kind === "reply" && typeof event.text === "string");
    const latest = proseExcerpt(reply?.text, 500);
    return [
      `The agent at ${source} is ${status}.`,
      question?.text && `Question: ${question.text}`,
      question?.incomplete && `Read ${source} for the full question.`,
      latest?.text && `Latest reply: ${latest.text}`,
      latest?.incomplete && `Read ${source}/history for the full reply.`,
      inspection.lastError && `Read ${source} for error details.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (item.operation === "agent.history") {
    const entries = Array.isArray(result?.matches) ? result.matches : result?.items;
    if (Array.isArray(entries)) {
      if (!entries.length) return "The recovered history had no results.";
      return source
        ? `The recovered history has results. Read ${source}/history or repeat the search to see them.`
        : "The recovered history has results. Repeat the interrupted history read or search to see them.";
    }
  }
  if (item.operation === "workflow.get" && Array.isArray(result?.profiles)) {
    const profiles = result.profiles.map((entry: unknown) => {
      const profile = record(entry);
      if (!profile || typeof profile.id !== "string") return undefined;
      const description =
        typeof profile.description === "string" ? oneLine(profile.description) : "";
      return `Profile ${oneLine(profile.id)}${description ? `: ${description}` : ""}.`;
    });
    if (profiles.some((profile: unknown) => !profile))
      return "The recovered profiles were incomplete. Read herdr:profiles again.";
    return profiles.length ? profiles.join("\n") : "There are no workflow profiles.";
  }
  if (item.operation === "agent.send" && result?.outcome === "submitted" && source)
    return `The message was submitted to ${source}.`;
  if (item.operation === "agent.remove" && result?.outcome === "removed" && source)
    return `The agent at ${source} was closed.`;
  if ((item.operation === "agent.replicate" || item.operation === "agent.subagent") && source) {
    if (item.operation === "agent.replicate") {
      if (result?.outcome === "unknown") return uncertain(source);
      return `A replica tab was created at ${source}. Read it to check whether the agent started.`;
    }
    if (result?.outcome === "started") return `The sub-agent started at ${source}.`;
    if (result?.outcome === "blocked")
      return `The sub-agent at ${source} is waiting for an answer. Read it to see what it needs.`;
    if (result?.outcome === "pending")
      return `The sub-agent at ${source} is still starting. Read it before retrying.`;
    return `The sub-agent at ${source} did not confirm a successful start. Read it before taking further action.`;
  }
  return readOnly
    ? "The recovered Herdr read could not be presented. Repeat the read."
    : "The recovered Herdr action could not be confirmed. Inspect its effects before retrying.";
}
/** Deliver interrupted App outcomes only after they are written into the originating session. */
export function registerRecovery(
  pi: ExtensionAPI,
  options: { pollMs?: number; sessionFileExists?: (path: string) => boolean } = {},
): void {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeQueued = false;
  let reportedError = false;
  const proposed = new Map<string, number>();
  let serial: Promise<unknown> = Promise.resolve();
  const pollMs = options.pollMs ?? 5000;
  pi.registerMessageRenderer(DELIVERY, (message, _options, theme) => {
    const items = record(message.details)?.items;
    const count = Array.isArray(items) ? items.length : 0;
    return new Text(
      theme.fg("muted", `Recovered ${count} Herdr request outcome${count === 1 ? "" : "s"}.`),
      0,
      0,
    );
  });
  const bridge = () => {
    let result: Bridge | undefined;
    pi.events.emit("herdr:bridge", {
      provide(value: Bridge) {
        result = value;
      },
    });
    return result?.version === 1 ? result.recovery : undefined;
  };
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = serial.then(fn, fn);
    serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const saved = (ctx: ExtensionContext): { recovery: Set<string>; tool: Set<string> } => {
    const recovery = new Set<string>();
    const tool = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      let values: unknown[];
      let target: Set<string>;
      if (entry.type === "custom_message" && entry.customType === DELIVERY) {
        values = [record(entry.details)?.items];
        target = recovery;
      } else if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        !entry.message.isError
      ) {
        const details = record(entry.message.details);
        const name = entry.message.toolName;
        values = [];
        if ((name === "read" || name === "search") && isHerdr(details, true))
          values.push(details?.herdrReceipts);
        if ((name === "replicate" || name === "subagent") && isHerdr(details, false))
          values.push(details?.herdrReceipts);
        if (name === "write" || name === "delete") {
          const action = record(record(details?.metadata)?.semanticAction);
          if (isHerdr(action, true)) values.push(action?.herdrReceipts);
        }
        if (name === "read" && Array.isArray(details?.resources)) {
          for (const resource of details.resources as unknown[]) {
            const resourceDetails = record(record(resource)?.details);
            if (isHerdr(resourceDetails, true)) values.push(resourceDetails?.herdrReceipts);
          }
        }
        target = tool;
      } else continue;
      for (const items of values) {
        if (!Array.isArray(items)) continue;
        for (const value of items as unknown[]) {
          const item = record(value);
          if (item && typeof item.id === "string" && typeof item.revision === "string")
            target.add(key({ id: item.id, revision: item.revision }));
        }
      }
    }
    return { recovery, tool };
  };
  const collect = (ctx: ExtensionContext, epoch: number, reserve = false) =>
    run(async () => {
      const session = ctx.sessionManager.getSessionId();
      const current = () => generation === epoch && ctx.sessionManager.getSessionId() === session;
      if (!current()) return [];
      const api = bridge();
      if (!api || typeof api.list !== "function" || typeof api.ack !== "function") return [];
      const list = await api.list();
      if (!current()) return [];
      if (!Array.isArray(list)) throw new Error("Invalid recovery response");
      const sessionFile = ctx.sessionManager.getSessionFile();
      // Pi defers creating a new session file until a user or assistant message exists.
      const seen =
        sessionFile && (options.sessionFileExists ?? existsSync)(sessionFile)
          ? saved(ctx)
          : { recovery: new Set<string>(), tool: new Set<string>() };
      const items = (list as unknown[]).filter(isItem).filter((item) => item.session === session);
      const wasDelivered = (item: RecoveryItem) =>
        seen.recovery.has(key(item)) || (item.state === "result" && seen.tool.has(key(item)));
      if (seen.recovery.size) pi.events.emit("herdr:recovery-persisted", { ctx });
      const delivered = items.filter(wasDelivered).map(({ id, revision }) => ({ id, revision }));
      let ackFailed = false;
      try {
        await api.ack({ items: delivered });
      } catch (error) {
        ackFailed = true;
        if (current()) reportError(ctx, error);
      }
      if (!current()) return [];
      if (!ackFailed) reportedError = false;
      if (!sessionFile) return [];
      const now = Date.now();
      for (const [id, at] of proposed)
        if (seen.recovery.has(id) || now - at >= 5000) proposed.delete(id);
      const ready = items.filter(
        (item) => item.recoverable === true && !wasDelivered(item) && !proposed.has(key(item)),
      );
      if (reserve) for (const item of ready) proposed.set(key(item), now);
      return ready;
    });
  const message = (items: RecoveryItem[]) => {
    const outcomes = items.map(({ id, revision, operation, state, result, error, evidence }) => ({
      id,
      revision,
      operation,
      state,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
      ...(evidence === undefined ? {} : { evidence }),
    }));
    return {
      customType: DELIVERY,
      content: items.map(describeOutcome).join("\n\n"),
      display: true,
      details: {
        outcomes,
        items: items.map(({ id, revision }) => ({ id, revision })),
        helpers: items.flatMap((item) => {
          const kind =
            item.operation === "agent.replicate"
              ? "replica"
              : item.operation === "agent.subagent"
                ? "subagent"
                : undefined;
          const result = record(item.result);
          if (
            !kind ||
            item.state !== "result" ||
            typeof result?.terminal !== "string" ||
            !result.terminal
          )
            return [];
          return [
            {
              terminal: result.terminal,
              name: typeof result.name === "string" ? result.name : result.terminal,
              owner: item.session,
              kind,
            },
          ];
        }),
      },
    };
  };
  const reportError = (ctx: ExtensionContext, error: unknown) => {
    if (reportedError) return;
    reportedError = true;
    const detail = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`Herdr recovery is unavailable: ${detail}`, "warning");
    else console.error(`Herdr recovery is unavailable: ${detail}`);
  };
  const schedule = (ctx: ExtensionContext, epoch: number) => {
    timer = setTimeout(() => {
      void (async () => {
        if (generation !== epoch) return;
        try {
          const items = await collect(ctx, epoch);
          if (generation === epoch && items.length && ctx.isIdle() && !wakeQueued) {
            wakeQueued = true;
            pi.sendMessage(
              {
                customType: WAKE,
                content: "Herdr has recovered request outcomes.",
                display: false,
              },
              { triggerTurn: true },
            );
          }
        } catch (error) {
          if (generation === epoch) {
            wakeQueued = false;
            reportError(ctx, error);
          }
        }
        if (generation === epoch) schedule(ctx, epoch);
      })();
    }, pollMs);
    timer.unref();
  };
  pi.on("session_start", (_event, ctx) => {
    const epoch = ++generation;
    serial = Promise.resolve();
    wakeQueued = false;
    reportedError = false;
    schedule(ctx, epoch);
  });
  pi.on("session_shutdown", () => {
    generation++;
    wakeQueued = false;
    proposed.clear();
    if (timer) clearTimeout(timer);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const epoch = generation;
    wakeQueued = false;
    try {
      const items = await collect(ctx, epoch, true);
      if (generation === epoch && items.length) return { message: message(items) };
    } catch (error) {
      if (generation === epoch) reportError(ctx, error);
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    const epoch = generation;
    try {
      const items = await collect(ctx, epoch, true);
      if (generation === epoch && items.length)
        return {
          entries: [...event.entries, { type: "custom_message", ...message(items) }],
          continue: true,
        };
    } catch (error) {
      if (generation === epoch) reportError(ctx, error);
    }
  });
  pi.on("agent_settled", () => {
    wakeQueued = false;
  });
}
