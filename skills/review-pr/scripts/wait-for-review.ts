import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

/** Feedback identity is namespaced because GitHub uses separate IDs for each feed. */
export interface ReviewEvent {
  kind: string;
  id: number;
  [field: string]: unknown;
}

/** Persisted observation, not a record of approval or completed agent work. */
export interface Snapshot {
  repo: string;
  number: number;
  pr: { head: string; state: string; merged: boolean; draft: boolean };
  events: ReviewEvent[];
}

type Change =
  | { type: "pull-request"; before: Snapshot["pr"]; after: Snapshot["pr"] }
  | { type: "added" | "updated" | "removed"; event: ReviewEvent };
type Request = (endpoint: string, paginate: boolean) => Promise<unknown>;
const exec = promisify(execFile);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub object");
  }
  return value as Record<string, unknown>;
}

const github: Request = async (endpoint, paginate) => {
  const args = ["api", "--hostname", "github.com", "--method", "GET", endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  const { stdout } = await exec("gh", args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as unknown;
};

/** Read PR state and every page of comments, reviews, and inline comments. Never mutate GitHub. */
export async function fetchSnapshot(
  repo: string,
  number: number,
  request: Request = github,
): Promise<Snapshot> {
  const root = `repos/${repo}`;
  const pull = `${root}/pulls/${number}`;
  const [raw, comments, reviews, inline] = await Promise.all([
    request(pull, false),
    request(`${root}/issues/${number}/comments?per_page=100`, true),
    request(`${pull}/reviews?per_page=100`, true),
    request(`${pull}/comments?per_page=100`, true),
  ]);
  const pr = object(raw);
  const head = object(pr.head).sha;
  if (
    typeof head !== "string" ||
    typeof pr.state !== "string" ||
    !["open", "closed"].includes(pr.state) ||
    typeof pr.merged !== "boolean" ||
    typeof pr.draft !== "boolean"
  ) {
    throw new Error("Invalid pull request response");
  }
  const events: ReviewEvent[] = [];
  const feeds: [string, unknown][] = [
    ["comment", comments],
    ["review", reviews],
    ["inline-comment", inline],
  ];
  for (const [kind, pages] of feeds) {
    if (!Array.isArray(pages) || !pages.every(Array.isArray))
      throw new Error("Invalid feedback pages");
    const items: unknown[] = pages.flat();
    for (const rawItem of items) {
      const item = object(rawItem);
      if (typeof item.id !== "number") throw new Error("Invalid feedback ID");
      events.push({
        kind,
        id: item.id,
        author: object(item.user).login,
        body: item.body,
        url: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        submittedAt: item.submitted_at,
        state: item.state,
        commit: item.commit_id,
        path: item.path,
        line: item.line,
        replyTo: item.in_reply_to_id,
      });
    }
  }
  // Normalize missing fields so disk cursors compare exactly with fresh API results.
  return JSON.parse(
    JSON.stringify({
      repo,
      number,
      pr: { head, state: pr.state, merged: pr.merged, draft: pr.draft },
      events,
    }),
  ) as Snapshot;
}

/** Return new, edited, or removed feedback and changes to the reviewed PR head or state. */
export function changesSince(before: Snapshot, after: Snapshot): Change[] {
  if (before.repo !== after.repo || before.number !== after.number)
    throw new Error("Cursor belongs to another PR");
  const changes: Change[] = [];
  if (JSON.stringify(before.pr) !== JSON.stringify(after.pr)) {
    changes.push({ type: "pull-request", before: before.pr, after: after.pr });
  }
  const key = (event: ReviewEvent) => `${event.kind}:${event.id}`;
  const oldEvents = new Map(before.events.map((event) => [key(event), event]));
  for (const event of after.events) {
    const old = oldEvents.get(key(event));
    if (!old) changes.push({ type: "added", event });
    else if (JSON.stringify(old) !== JSON.stringify(event))
      changes.push({ type: "updated", event });
    oldEvents.delete(key(event));
  }
  for (const event of oldEvents.values()) changes.push({ type: "removed", event });
  return changes;
}

/** Poll quietly until feedback changes or the bounded wait ends. Errors never imply approval. */
export async function waitForChange(
  before: Snapshot,
  {
    fetch = () => fetchSnapshot(before.repo, before.number),
    intervalMs = 60_000,
    timeoutMs = 3_600_000,
    now = Date.now,
    sleep: pause = sleep,
  }: {
    fetch?: () => Promise<Snapshot>;
    intervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<{ status: string; snapshot: Snapshot; changes: Change[] }> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const snapshot = await fetch();
    const changes = changesSince(before, snapshot);
    if (changes.length) return { status: "changed", snapshot, changes };
    if (snapshot.pr.state === "closed") return { status: "closed", snapshot, changes: [] };
    const remaining = deadline - now();
    if (remaining <= 0) return { status: "timeout", snapshot, changes: [] };
    await pause(Math.min(intervalMs, remaining));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      cursor: { type: "string" },
      "interval-seconds": { type: "string", default: "60" },
      "timeout-seconds": { type: "string", default: "3600" },
    },
  });
  const [command] = positionals;
  const number = Number(values.pr);
  const intervalMs = Number(values["interval-seconds"]) * 1000;
  const timeoutMs = Number(values["timeout-seconds"]) * 1000;
  if (
    positionals.length !== 1 ||
    !command ||
    !["init", "wait", "read"].includes(command) ||
    !values.repo ||
    !/^[\w.-]+\/[\w.-]+$/.test(values.repo) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      "Usage: node wait-for-review.ts init|wait|read --repo OWNER/REPO --pr NUMBER [--cursor FILE] [--interval-seconds 60] [--timeout-seconds 3600]",
    );
  }
  if (command === "read") {
    console.log(
      JSON.stringify({ status: "snapshot", snapshot: await fetchSnapshot(values.repo, number) }),
    );
    return;
  }
  if (!values.cursor) throw new Error("init and wait require --cursor FILE");
  const cursor = resolve(values.cursor);
  let result;
  if (command === "init") {
    result = { status: "initialized", snapshot: await fetchSnapshot(values.repo, number) };
    await mkdir(dirname(cursor), { recursive: true });
    await writeFile(cursor, JSON.stringify(result.snapshot), { flag: "wx", mode: 0o600 });
  } else {
    const before = JSON.parse(await readFile(cursor, "utf8")) as Snapshot;
    if (before.repo !== values.repo || before.number !== number)
      throw new Error("Cursor belongs to another PR");
    result = await waitForChange(before, { intervalMs, timeoutMs });
    // One listener owns this cursor. Atomic replacement keeps it readable after interruption.
    const pending = `${cursor}.${process.pid}.tmp`;
    await writeFile(pending, JSON.stringify(result.snapshot), { mode: 0o600 });
    await rename(pending, cursor);
  }
  // JSON escapes terminal controls in remote text. It is review data, not agent instructions.
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
