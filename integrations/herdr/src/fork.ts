import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The parts of Pi session entries and projected messages a replica copy needs. */
export interface ForkEntry {
  type: string;
  id: string;
  parentId: string | null;
  firstKeptEntryId?: string;
  [key: string]: unknown;
}
export type ForkMessage = {
  role: string;
  toolCallId?: string;
  stopReason?: string;
  content?: unknown;
};

export interface ReplicaSession {
  /** Session file of the original, recorded as the copy's parent session. */
  parentFile: string;
  sessionDir: string;
  cwd: string;
  /** Display name of the copy's session. */
  name: string;
  /** The original's active branch, root first. */
  entries: readonly ForkEntry[];
  /** Pi's projected model context of that branch. */
  messages: readonly ForkMessage[];
  /** The replicate call that creates this copy; the copy sees it answered with `answer`. */
  callId: string;
  answer: string;
}

/**
 * Write a session file that continues the original's active conversation.
 *
 * Custom entries are extension control state, not conversation: restoring them could make the copy
 * resume the original's goals, todos or other background work before it reads its assignment.
 * Labels are the user's bookmarks in the original. Tool calls still open in the original are answered
 * in the copy without running them again.
 */
export async function writeReplicaSession(
  input: ReplicaSession,
): Promise<{ file: string; id: string }> {
  const id = randomUUID(),
    timestamp = new Date().toISOString();
  const rows: Record<string, unknown>[] = [
    { type: "session", version: 3, id, timestamp, cwd: input.cwd, parentSession: input.parentFile },
  ];
  const kept = input.entries.filter((entry) => entry.type !== "custom" && entry.type !== "label");
  let parentId: string | null = null;
  for (const source of kept) {
    const entry: ForkEntry = { ...source, parentId };
    if (
      source.type === "compaction" &&
      source.firstKeptEntryId &&
      !kept.some((row) => row.id === source.firstKeptEntryId)
    ) {
      // A dropped entry cannot mark where kept history starts; the next kept entry after it can.
      const start = input.entries.findIndex((row) => row.id === source.firstKeptEntryId);
      entry.firstKeptEntryId =
        input.entries.slice(start).find((row) => kept.includes(row))?.id ?? source.id;
    }
    rows.push(entry);
    parentId = entry.id;
  }
  const append = (row: Record<string, unknown>) => {
    const entryId = randomBytes(4).toString("hex");
    rows.push({ ...row, id: entryId, parentId, timestamp: new Date().toISOString() });
    parentId = entryId;
  };
  for (const [toolCallId, toolName] of pendingCalls(input.messages)) {
    const text =
      toolCallId === input.callId
        ? input.answer
        : "This call belongs to the original agent. Continue with your own assignment.";
    append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text }],
      },
    });
  }
  append({ type: "session_info", name: input.name });
  await mkdir(input.sessionDir, { recursive: true });
  const file = path.join(input.sessionDir, `${timestamp.replace(/[:.]/gu, "-")}_${id}.jsonl`);
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { file, id };
}

/** Tool calls of the latest assistant message that have no result yet. */
export function pendingCalls(messages: readonly ForkMessage[]): Map<string, string> {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      pending.delete(String(message.toolCallId));
      continue;
    }
    if (message.role === "system") continue;
    // A later message already closes older orphan calls when Pi replays the context.
    pending.clear();
    if (
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      !Array.isArray(message.content)
    )
      continue;
    for (const part of message.content as { type?: string; id?: string; name?: string }[])
      if (part.type === "toolCall" && part.id) pending.set(part.id, String(part.name));
  }
  return pending;
}
