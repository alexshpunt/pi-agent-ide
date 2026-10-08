import assert from "node:assert/strict";
import { test } from "vitest";

import {
  changesSince,
  fetchSnapshot,
  waitForChange,
  type ReviewEvent,
  type Snapshot,
} from "#skills/review-pr/scripts/wait-for-review.js";

const snapshot = (events: ReviewEvent[] = [], pr: Partial<Snapshot["pr"]> = {}): Snapshot => ({
  repo: "owner/repo",
  number: 1,
  pr: { head: "abc", state: "open", merged: false, draft: false, ...pr },
  events,
});
const comment = (id: number, body = "Please fix this") => ({ kind: "comment", id, body });

test("reports new and edited comments without repeating old ones", () => {
  const before = snapshot([comment(1)]);
  assert.deepEqual(changesSince(before, before), []);
  assert.deepEqual(changesSince(before, snapshot([comment(1), comment(2)])), [
    { type: "added", event: comment(2) },
  ]);
  assert.deepEqual(changesSince(before, snapshot([comment(1, "New request")])), [
    { type: "updated", event: comment(1, "New request") },
  ]);
});

test("reports approval, changes requested, dismissal, and inline replies", () => {
  for (const state of ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]) {
    const event = { kind: "review", id: 2, state, commit: "abc", author: "human" };
    assert.deepEqual(changesSince(snapshot(), snapshot([event])), [{ type: "added", event }]);
  }
  const dismissed = { kind: "review", id: 2, state: "DISMISSED" };
  assert.deepEqual(
    changesSince(snapshot([{ ...dismissed, state: "APPROVED" }]), snapshot([dismissed])),
    [{ type: "updated", event: dismissed }],
  );
  const reply = { kind: "inline-comment", id: 3, replyTo: 1, path: "file.ts", body: "Fix it" };
  assert.deepEqual(changesSince(snapshot(), snapshot([reply])), [{ type: "added", event: reply }]);
});

test("reports head, draft, closing, and merge changes", () => {
  for (const pr of [{ head: "def" }, { draft: true }, { state: "closed" }, { merged: true }]) {
    assert.deepEqual(changesSince(snapshot(), snapshot([], pr)), [
      { type: "pull-request", before: snapshot().pr, after: snapshot([], pr).pr },
    ]);
  }
});

test("reports deleted feedback and refuses a cursor for another PR", () => {
  assert.deepEqual(changesSince(snapshot([comment(1)]), snapshot()), [
    { type: "removed", event: comment(1) },
  ]);
  assert.throws(() => changesSince(snapshot(), { ...snapshot(), number: 2 }), /another PR/);
});

test("waits quietly, then returns the first changed snapshot", async () => {
  const after = snapshot([comment(2)]);
  const queue = [snapshot(), after];
  const sleeps: number[] = [];
  const result = await waitForChange(snapshot(), {
    fetch: async () => {
      const next = queue.shift();
      assert.ok(next);
      return next;
    },
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
    intervalMs: 60_000,
    timeoutMs: 3_600_000,
  });
  assert.equal(result.status, "changed");
  assert.deepEqual(result.snapshot, after);
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(changesSince(result.snapshot, after), []);
});

test("timeout is not approval and API failure is not an empty result", async () => {
  let time = 0;
  const result = await waitForChange(snapshot(), {
    fetch: async () => snapshot(),
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    intervalMs: 60_000,
    timeoutMs: 10_000,
  });
  assert.equal(result.status, "timeout");
  assert.equal(time, 10_000);
  await assert.rejects(
    waitForChange(snapshot(), {
      fetch: async () => {
        throw new Error("HTTP 403");
      },
    }),
    /HTTP 403/,
  );
});

test("closed PRs stop waiting and malformed API responses fail visibly", async () => {
  const closed = snapshot([], { state: "closed" });
  const result = await waitForChange(closed, { fetch: async () => closed });
  assert.equal(result.status, "closed");
  await assert.rejects(
    fetchSnapshot("owner/repo", 1, async () => null),
    /Invalid GitHub object/,
  );
});
test("collects all three paginated feedback feeds with review identity and head", async () => {
  const endpoints: { endpoint: string; paginate: boolean }[] = [];
  const result = await fetchSnapshot("owner/repo", 1, async (endpoint, paginate) => {
    endpoints.push({ endpoint, paginate });
    if (endpoint === "repos/owner/repo/pulls/1") {
      return { head: { sha: "abc" }, state: "open", merged: false, draft: false };
    }
    const base = {
      user: { login: "human" },
      body: "Feedback",
      html_url: "https://github.com/review",
    };
    if (endpoint.includes("/reviews"))
      return [
        [{ ...base, id: 1, state: "APPROVED", commit_id: "abc", submitted_at: "2026-01-01" }],
        [{ ...base, id: 2, state: "CHANGES_REQUESTED", commit_id: "old" }],
      ];
    if (endpoint.includes("/issues/")) return [[{ ...base, id: 1 }]];
    return [[{ ...base, id: 1, path: "file.ts", line: 5, in_reply_to_id: 2 }]];
  });
  assert.equal(result.events.length, 4);
  const approved = result.events.find((event) => event.state === "APPROVED");
  const reply = result.events.find((event) => event.kind === "inline-comment");
  assert.ok(approved);
  assert.ok(reply);
  assert.equal(approved.commit, "abc");
  assert.equal(approved.author, "human");
  assert.equal(reply.replyTo, 2);
  assert.equal(endpoints.filter((entry) => entry.paginate).length, 3);
  assert.equal(result.pr.head, "abc");
});
