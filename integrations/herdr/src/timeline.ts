import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export type Event =
  | { kind: "reply" | "reasoning"; at: string; text: string }
  | {
      kind: "call";
      at: string;
      tool: string;
      summary: string;
      state: "running" | "failed" | "done";
    };
export interface Inspection {
  terminal: string;
  name?: string;
  state: string;
  status?: string;
  exited?: boolean;
  pid: number;
  session: string;
  inspection: {
    busy: boolean;
    failed: boolean;
    pendingQuestion?: string;
    lastError?: string;
    omitted: { calls: number; reasoning: number };
    events: Event[];
  };
}
export type Status = "working" | "waiting" | "idle" | "error" | "exited";
export function agentStatusOf(value: {
  status?: string;
  state?: string;
  exited?: boolean;
}): Status {
  if (value.exited || value.status === "exited" || value.state !== "live") return "exited";
  if (value.status === "blocked") return "waiting";
  if (value.status === "working" || value.status === "error") return value.status;
  return "idle";
}
export function statusOf(value: Inspection): Status {
  if (value.exited || value.status === "exited" || value.state !== "live") return "exited";
  if (value.inspection.pendingQuestion) return "waiting";
  if (value.inspection.busy) return "working";
  if (value.inspection.failed) return "error";
  return "idle";
}
export const clean = (text: string) =>
  stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, "");
export const oneLine = (text: string) => clean(text).replace(/\s+/gu, " ").trim();

/** Keep both ends and count removed UTF-16 characters, without splitting a surrogate. */
export function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let keep = Math.max(0, limit - 32);
  for (;;) {
    const head = text.slice(0, Math.ceil(keep / 2)).replace(/[\uD800-\uDBFF]$/u, "");
    const tail = keep < 2 ? "" : text.slice(-Math.floor(keep / 2)).replace(/^[\uDC00-\uDFFF]/u, "");
    const marker = `[… ${text.length - head.length - tail.length} characters cut …]`;
    const result = head + marker + tail;
    if (result.length <= limit || keep === 0) return result;
    keep -= result.length - limit;
  }
}
export function budgetValue(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/u.test(raw))
    throw new Error("Herdr read budget must be an integer from 500 to 20000");
  const value = Number(raw);
  if (value < 500 || value > 20000)
    throw new Error("Herdr read budget must be an integer from 500 to 20000");
  return value;
}

export function renderTimeline(value: Inspection, budget: number, unchanged = false): string {
  const snapshot = value.inspection;
  const status = statusOf(value);
  let header = `status: ${status} · ${oneLine(value.name || value.terminal)}`;
  const sticky: { prefix: string; text: string }[] = [];
  if (status === "waiting" && snapshot.pendingQuestion)
    sticky.push({ prefix: "question: ", text: clean(snapshot.pendingQuestion) });
  if (snapshot.lastError) sticky.push({ prefix: "error: ", text: clean(snapshot.lastError) });
  // Mandatory fields remain present even when a question alone exceeds the chosen budget.
  if (header.length > 160) header = cut(header, 160);
  const stickyBudget =
    budget - header.length - sticky.reduce((n, field) => n + field.prefix.length + 1, 0);
  if (sticky.reduce((n, field) => n + field.text.length, 0) > stickyBudget) {
    let remaining = stickyBudget;
    for (let i = 0; i < sticky.length; i++) {
      const field = sticky[i];
      field.text = cut(field.text, Math.floor(remaining / (sticky.length - i)));
      remaining -= field.text.length;
    }
  }
  const prelude = [header, ...sticky.map((field) => field.prefix + field.text)].join("\n");
  const events = snapshot.events.map((event) =>
    event.kind === "call"
      ? {
          kind: event.kind,
          text: `call: ${oneLine(event.tool)}${oneLine(event.summary) ? ` · ${oneLine(event.summary)}` : ""}${event.state === "done" ? "" : ` (${event.state})`}`,
        }
      : {
          kind: event.kind,
          text:
            event.kind === "reply"
              ? unchanged
                ? "unchanged since your last read"
                : clean(event.text)
              : cut(oneLine(event.text), 150),
        },
  );
  let omitted = snapshot.omitted.calls + snapshot.omitted.reasoning;
  const format = () => {
    const lines = [prelude];
    let marked = false;
    for (const event of events) {
      if (!marked && event.kind !== "reply") {
        if (omitted) lines.push(`… ${omitted} earlier steps`);
        marked = true;
      }
      lines.push(
        event.kind === "call"
          ? event.text
          : `${event.kind === "reply" ? "reply" : "thinking"}: ${event.text}`,
      );
    }
    if (!marked && omitted) lines.push(`… ${omitted} earlier steps`);
    return lines.join("\n");
  };
  const drop = (kind: "call" | "reasoning") => {
    const index = events.findIndex((event) => event.kind === kind);
    if (index < 0) return false;
    events.splice(index, 1);
    omitted++;
    return true;
  };
  let reply = events.find((event) => event.kind === "reply");
  if (format().length > budget && status === "working" && reply && !unchanged) {
    const available = budget - (format().length - reply.text.length);
    if (available >= 40) reply.text = cut(reply.text, Math.min(600, available));
    else {
      events.splice(events.indexOf(reply), 1);
      reply = undefined;
    }
  }
  for (const kind of status === "working"
    ? (["reasoning", "call"] as const)
    : (["call", "reasoning"] as const)) {
    while (format().length > budget && drop(kind)) {
      /* preserve the newest steps */
    }
  }
  if (format().length > budget && reply) {
    const available = budget - (format().length - reply.text.length);
    if (available >= 40) reply.text = cut(reply.text, available);
    else events.splice(events.indexOf(reply), 1);
  }
  // A very long mandatory question may leave no space for a steps marker.
  if (format().length > budget) omitted = 0;
  return format();
}

type Cursor = { pid: number; session: string; replyAt?: string; replyHash?: string };
/** Identify the latest reply, so a changed reply is detected without trusting the target's clock. */
export function replyHashOf(value: Inspection): string | undefined {
  const reply = value.inspection.events.find((event) => event.kind === "reply");
  return reply && reply.kind !== "call"
    ? createHash("sha256").update(`${reply.at}\0${reply.text}`).digest("hex")
    : undefined;
}
function cursorOf(value: Inspection): Cursor {
  const reply = value.inspection.events.find((event) => event.kind === "reply");
  return {
    pid: value.pid,
    session: value.session,
    ...(reply && reply.kind !== "call"
      ? {
          replyAt: reply.at,
          replyHash: replyHashOf(value),
        }
      : {}),
  };
}
export class ReadCursor {
  private owners = new Map<string, Map<string, Cursor>>();
  unchanged(owner: string, value: Inspection): boolean {
    const previous = this.owners.get(owner)?.get(value.terminal),
      next = cursorOf(value);
    return (
      !!previous &&
      !!next.replyHash &&
      previous.pid === next.pid &&
      previous.session === next.session &&
      previous.replyAt === next.replyAt &&
      previous.replyHash === next.replyHash
    );
  }
  record(owner: string, value: Inspection): void {
    let terminals = this.owners.get(owner);
    if (!terminals) this.owners.set(owner, (terminals = new Map()));
    terminals.set(value.terminal, cursorOf(value));
  }
  /** Record only the agent's identity, keeping its reply unread, unless a read already recorded it. */
  pin(owner: string, value: Inspection): void {
    let terminals = this.owners.get(owner);
    if (!terminals) this.owners.set(owner, (terminals = new Map()));
    if (!terminals.has(value.terminal))
      terminals.set(value.terminal, { pid: value.pid, session: value.session });
  }
  replyHash(owner: string, terminal: string): string | undefined {
    return this.owners.get(owner)?.get(terminal)?.replyHash;
  }
  forget(owner: string, terminal: string): void {
    this.owners.get(owner)?.delete(terminal);
  }
  identity(owner: string, terminal: string): { pid: number; session: string } | undefined {
    const value = this.owners.get(owner)?.get(terminal);
    return value ? { pid: value.pid, session: value.session } : undefined;
  }
}
