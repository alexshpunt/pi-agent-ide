import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pendingCalls, writeReplicaSession, type ForkEntry } from "#herdr/fork.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const at = "2026-11-19T00:00:00.000Z";
const user = (id: string, parentId: string | null, text: string): ForkEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: at,
  message: { role: "user", content: text, timestamp: 0 },
});
const calls = (id: string, parentId: string, ...ids: string[]): ForkEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: at,
  message: {
    role: "assistant",
    stopReason: "toolUse",
    content: ids.map((call) => ({
      type: "toolCall",
      id: call,
      name: call === "c1" ? "replicate" : "read",
      arguments: {},
    })),
  },
});

describe("replica session copy", () => {
  it("copies the conversation, drops extension state and answers open calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "herdr-fork-"));
    dirs.push(dir);
    const entries: ForkEntry[] = [
      { type: "model_change", id: "m", parentId: null, timestamp: at, provider: "p", modelId: "x" },
      user("u1", "m", "first task"),
      {
        type: "custom",
        id: "goal",
        parentId: "u1",
        timestamp: at,
        customType: "goal",
        data: { active: true },
      },
      {
        type: "compaction",
        id: "k",
        parentId: "goal",
        timestamp: at,
        summary: "s",
        firstKeptEntryId: "goal",
        tokensBefore: 1,
      },
      { type: "label", id: "l", parentId: "k", timestamp: at, targetId: "u1", label: "bookmark" },
      {
        type: "custom_message",
        id: "w",
        parentId: "l",
        timestamp: at,
        customType: "herdr-agents-wait",
        content: "agents stopped",
        display: true,
      },
      calls("a1", "w", "c1", "c2"),
    ];
    const messages = entries.flatMap((entry) => (entry.message ? [entry.message as never] : []));
    const fork = await writeReplicaSession({
      parentFile: "/sessions/original.jsonl",
      sessionDir: dir,
      cwd: "/repo",
      name: "check-auth",
      entries,
      messages,
      callId: "c1",
      answer: "You are the replica.",
    });
    expect(path.dirname(fork.file)).toBe(dir);
    expect(path.basename(fork.file)).toMatch(new RegExp(`_${fork.id}\\.jsonl$`, "u"));
    const rows = (await readFile(fork.file, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            parentId: string | null;
            firstKeptEntryId?: string;
            message?: { role: string; toolCallId: string; content: { text: string }[] };
          },
      );
    expect(rows[0]).toMatchObject({
      type: "session",
      version: 3,
      id: fork.id,
      cwd: "/repo",
      parentSession: "/sessions/original.jsonl",
    });
    expect(
      rows
        .slice(1)
        .map((row) => row.id)
        .slice(0, 5),
    ).toEqual(["m", "u1", "k", "w", "a1"]);
    // Every kept row hangs on the previous one, so the copy is one linear branch.
    for (let i = 2; i < rows.length; i++) expect(rows[i].parentId).toBe(rows[i - 1].id);
    expect(rows[1].parentId).toBeNull();
    // The compaction kept history from a dropped entry; it now starts at the next kept one.
    expect(rows.find((row) => row.id === "k")?.firstKeptEntryId).toBe("k");
    const results = rows
      .filter((row) => row.message?.role === "toolResult")
      .map((row) => [row.message?.toolCallId, row.message?.content[0].text]);
    expect(results).toEqual([
      ["c1", "You are the replica."],
      ["c2", expect.any(String)],
    ]);
    expect(results[1][1]).toBeTruthy();
    expect(rows.at(-1)).toMatchObject({ type: "session_info", name: "check-auth" });
  });

  it("answers only the calls of the latest assistant message that have no result", () => {
    const open = pendingCalls([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "old", name: "read" }],
      },
      { role: "user", content: "later" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "a", name: "read" },
          { type: "toolCall", id: "b", name: "replicate" },
        ],
      },
      { role: "toolResult", toolCallId: "a" },
    ]);
    expect([...open]).toEqual([["b", "replicate"]]);
    expect(
      pendingCalls([
        {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolCall", id: "x", name: "read" }],
        },
      ]).size,
    ).toBe(0);
  });
});
