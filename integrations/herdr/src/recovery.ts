import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
      content: `Recovered Herdr request outcomes. Inspect effects before retrying any operation with an unknown outcome.\n${JSON.stringify(outcomes)}`,
      display: true,
      details: {
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
