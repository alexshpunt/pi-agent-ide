import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertTuiHistoryInvocation,
  guardTuiHistory,
  reopenTuiHistory,
  TUI_HISTORY_SESSION,
  validateTuiHistory,
} from "#capabilities/tui.ts";
import * as sandbox from "#capabilities/sandbox.ts";
import { expect, test, vi } from "vitest";

test("history requires the one-attempt terminal route", () => {
  expect(() => assertTuiHistoryInvocation(["--run", "--tui-history"])).toThrow(/requires --tui/);
  expect(() => assertTuiHistoryInvocation(["--run", "--tui", "--tui-history"])).not.toThrow();
  expect(() => assertTuiHistoryInvocation(["--run"])).not.toThrow();
});

test.each([
  { events: [] },
  { events: [null] },
  { events: [{ type: 1 }] },
  { events: [{ type: "history_restored", restored: false }] },
  {
    events: [
      { type: "history_restored", restored: true },
      { type: "history_restored", restored: true },
    ],
  },
  {
    events: [{ type: "history_restored", restored: true }, { type: "history_agent_start_refused" }],
  },
  {
    events: [
      { type: "history_restored", restored: true },
      { type: "history_provider_request_refused" },
    ],
  },
])("missing, malformed, duplicate or active history does not pass: %j", ({ events }) => {
  expect(validateTuiHistory(events).length).toBeGreaterThan(0);
});

test("raw agent activity cannot be mistaken for an idle restoration", () => {
  expect(
    validateTuiHistory([{ type: "history_restored", restored: true }, { type: "agent_start" }]),
  ).not.toEqual([]);
});
test("exactly one observed idle restoration passes", () => {
  expect(validateTuiHistory([{ type: "history_restored", restored: true }])).toEqual([]);
});

test.each([undefined, "invalid JSON"])(
  "missing or malformed history keeps the real termination outcome: %j",
  async (observations) => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/capability-history-outcome-"));
    const execution = { code: 7, signal: null, timedOut: false, stdout: "", stderr: "" };
    const run = vi.spyOn(sandbox, "runProcess").mockResolvedValue(execution);
    try {
      await writeFile(path.join(root, "capability-history.jsonl"), "{}\n");
      if (observations) await writeFile(path.join(root, "history-events.jsonl"), observations);
      const restored = await reopenTuiHistory({
        sandbox: ["--"],
        cli: "/fixture/pi",
        piArgs: ["--session", TUI_HISTORY_SESSION],
        state: root,
        env: {},
        timeoutMs: 1000,
      });
      expect(restored.execution).toBe(execution);
      expect(restored.reasons).toEqual([
        "History observations are unavailable or malformed",
        "History inspection did not exit normally",
      ]);
      expect(run.mock.calls[0]?.[1]).toContain("--unshare-net");
    } finally {
      run.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("history guard refuses agent and provider work and rejects an empty saved session", async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/capability-history-"));
  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi: Pick<ExtensionAPI, "on"> = {
      on: (name, handler) => {
        handlers.set(name, handler as (...args: unknown[]) => unknown);
        return () => {
          handlers.delete(name);
        };
      },
    };
    let aborted = 0;
    let shutdown = 0;
    const context = {
      abort: () => {
        aborted++;
      },
      shutdown: () => {
        shutdown++;
      },
      sessionManager: {
        getEntries: (): { type: string }[] => [],
        getSessionFile: (): string => TUI_HISTORY_SESSION,
        getSessionId: () => "fixture",
      },
    };
    const file = path.join(root, "events.jsonl");
    guardTuiHistory(pi as ExtensionAPI, file);
    handlers.get("session_start")?.({}, context);
    expect(shutdown).toBe(1);
    context.sessionManager.getEntries = () => [{ type: "message" }];
    context.sessionManager.getSessionFile = () => "/state/another-session.jsonl";
    handlers.get("session_start")?.({}, context);
    expect(shutdown).toBe(2);
    handlers.get("agent_start")?.({}, context);
    expect(aborted).toBe(1);
    expect(() => handlers.get("before_provider_request")?.({}, context)).toThrow(
      /forbids provider/,
    );
    expect(aborted).toBe(2);
    expect(shutdown).toBe(4);
    const events: unknown[] = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(validateTuiHistory(events)).not.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
