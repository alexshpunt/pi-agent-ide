import { describe, expect, it } from "vitest";
import {
  REPLICA_CLOSED,
  REPLICA_MESSAGE,
  ReplicaWatcher,
  replicaAssignment,
  type ReplicaMessageDetails,
} from "#herdr/replicate.ts";
import { HerdrService } from "#herdr/service.ts";
import { AgentWaiter } from "#herdr/wait.ts";

type Fake = {
  terminal: string;
  status: string;
  busy?: boolean;
  reply: string;
  at?: string;
  listed: boolean;
  answers: boolean;
  pid?: number;
};
const inherited = "2026-11-19T00:00:00Z";
/** Give the fake replica a reply it wrote now, after the copy. */
const answer = (replica: Fake, reply: string) => {
  replica.reply = reply;
  replica.at = new Date(Date.now() + 1).toISOString();
};

/** A Herdr bridge with one replica whose state the test changes, and a Pi that records delivered messages. */
function harness(replica: Fake, owner = "owner", budget = async () => 3000) {
  const sent: { content: string; details: ReplicaMessageDetails; options: unknown }[] = [];
  const entries: { customType: string; data: unknown }[] = [];
  const commands: string[] = [];
  const events = {
    emit(_name: string, request: { provide(api: unknown): void }) {
      request.provide({
        version: 1,
        async command(name: string, args: Record<string, unknown>) {
          commands.push(name);
          if (name === "agent.list")
            return {
              agents: replica.listed
                ? [{ terminal: replica.terminal, name: "r", state: "live", status: replica.status }]
                : [],
            };
          if (name === "agent.inspect") {
            if (!replica.listed || !replica.answers)
              throw new Error("No Pi answers in this terminal yet");
            return {
              terminal: args.terminal,
              name: "r",
              state: "live",
              pid: replica.pid ?? 7,
              session: "replica-session",
              inspection: {
                busy: replica.busy ?? replica.status === "working",
                failed: false,
                omitted: { calls: 0, reasoning: 0 },
                events: [{ kind: "reply", at: replica.at ?? inherited, text: replica.reply }],
              },
            };
          }
          if (name === "agent.send") return { outcome: "submitted" };
          if (name === "agent.remove") return { outcome: "removed" };
          throw new Error(`unexpected ${name}`);
        },
      });
    },
  };
  const service = new HerdrService({ events } as never, () => owner);
  const waiter = new AgentWaiter(service, budget, {
    pollMs: 1,
    sendGraceMs: 5000,
    maxFailures: 50,
  });
  const pi = {
    sendMessage(message: { content: string; details: ReplicaMessageDetails }, options: unknown) {
      sent.push({ ...message, options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };
  const watcher = new ReplicaWatcher(pi as never, waiter, () => owner, {
    startupMs: 2000,
    restoreMs: 200,
  });
  return { service, watcher, sent, entries, commands };
}
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("replica watcher", () => {
  it("reports every new stop once, lets the original steer without a read, and reports the exit", async () => {
    // The copied conversation starts with the original's last reply.
    const replica: Fake = {
      terminal: "laptop/t9",
      status: "done",
      reply: "original-reply",
      listed: false,
      answers: false,
    };
    const h = harness(replica);
    h.watcher.follow(
      { terminal: "laptop/t9", name: "check-auth", since: Date.now(), restored: false },
      "/repo",
    );
    expect(h.watcher.count).toBe(1);
    await settle();
    replica.listed = true;
    await settle();
    replica.answers = true;
    await settle();
    // Idle at startup with the inherited reply: nothing to report yet.
    expect(h.sent).toHaveLength(0);
    replica.status = "working";
    await settle();
    replica.status = "done";
    answer(replica, "first-result");
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("herdr:laptop/t9");
    expect(h.sent[0].content).toContain("first-result");
    expect(h.sent[0].details).toMatchObject({
      terminal: "laptop/t9",
      name: "check-auth",
      owner: "owner",
      status: "idle",
      final: false,
    });
    expect(h.sent[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    await settle();
    expect(h.sent).toHaveLength(1);

    await h.service.send("herdr:laptop/t9", "Also check the logout path.");
    answer(replica, "second-result");
    await until(() => h.sent.length === 2);
    expect(h.sent[1].content).toContain("second-result");

    replica.listed = false;
    await until(() => h.sent.length === 3);
    expect(h.sent[2].content).toContain("herdr:laptop/t9");
    expect(h.sent[2].details).toMatchObject({ status: "exited", final: true });
    await until(() => h.watcher.count === 0);
  });

  it("reports a replica that is already working at its first stop", async () => {
    const replica: Fake = {
      terminal: "t9",
      status: "working",
      reply: "original-reply",
      listed: true,
      answers: true,
    };
    const h = harness(replica);
    h.watcher.follow({ terminal: "t9", name: "r", since: Date.now(), restored: false }, "/repo");
    await settle();
    replica.status = "done";
    await until(() => h.sent.length === 1);
    // An unchanged reply still reports the stop: the replica may have finished with the same words.
    expect(h.sent[0].details.status).toBe("idle");
  });

  it("reports a replica that already finished before the first inspection", async () => {
    const since = Date.now();
    const replica: Fake = {
      terminal: "t9",
      status: "done",
      reply: "x",
      listed: true,
      answers: true,
    };
    answer(replica, "done-quickly");
    const h = harness(replica);
    h.watcher.follow({ terminal: "t9", name: "r", since, restored: false }, "/repo");
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("done-quickly");
    h.watcher.stopAll();
  });

  it("stops quietly when the original closes the replica and remembers it", async () => {
    const replica: Fake = {
      terminal: "t9",
      status: "working",
      reply: "x",
      listed: true,
      answers: true,
    };
    const h = harness(replica);
    h.watcher.follow({ terminal: "t9", name: "r", restored: false }, "/repo");
    await settle();
    await h.service.remove("herdr:t9");
    h.watcher.closed("t9");
    replica.listed = false;
    await settle();
    expect(h.sent).toHaveLength(0);
    expect(h.watcher.count).toBe(0);
    expect(h.entries).toEqual([
      { customType: REPLICA_CLOSED, data: { terminal: "t9", owner: "owner" } },
    ]);
    expect(h.commands).toContain("agent.remove");
  });

  it("steers and closes a replica by its bare address without a read and stops following it", async () => {
    const replica: Fake = {
      terminal: "laptop/t9",
      status: "working",
      reply: "x",
      listed: true,
      answers: true,
    };
    const h = harness(replica);
    h.watcher.follow({ terminal: "laptop/t9", name: "r", restored: false }, "/repo");
    await settle();
    await h.service.send("herdr:t9", "Also check logout.");
    await h.service.remove("herdr:t9");
    h.watcher.closed("t9");
    replica.listed = false;
    await settle();
    expect(h.sent).toHaveLength(0);
    expect(h.entries).toEqual([
      { customType: REPLICA_CLOSED, data: { terminal: "laptop/t9", owner: "owner" } },
    ]);
  });

  it("reports a replica that never starts answering", async () => {
    const h = harness({
      terminal: "t9",
      status: "done",
      reply: "x",
      listed: false,
      answers: false,
    });
    h.watcher.follow({ terminal: "t9", name: "r", restored: false }, "/repo");
    await until(() => h.sent.length === 1, 4000);
    expect(h.sent[0].details.status).toBe("exited");
    expect(h.sent[0].details.final).toBe(true);
  });

  it("follows this session's open replicas again after a reload, without repeating a reported stop", async () => {
    const replica: Fake = {
      terminal: "t9",
      status: "done",
      reply: "reported",
      listed: true,
      answers: true,
    };
    const h = harness(replica);
    // Learn the signature of the state the original was already told about.
    h.watcher.follow({ terminal: "t9", name: "r", restored: false }, "/repo");
    replica.status = "working";
    await settle();
    replica.status = "done";
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("reported");
    h.watcher.stopAll();
    const reported = h.sent[0].details.signature;
    const result = (owner: string, terminal: string) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "replicate",
        isError: false,
        details: { terminal, name: terminal, owner, since: 0 },
      },
    });
    const branch = [
      result("owner", "t9"),
      {
        type: "custom_message",
        customType: REPLICA_MESSAGE,
        details: { terminal: "t9", owner: "owner", signature: reported, final: false },
      },
      // A copy inherits its original's replicas; they are not its own.
      result("another-session", "t8"),
      result("owner", "t7"),
      { type: "custom", customType: REPLICA_CLOSED, data: { terminal: "t7", owner: "owner" } },
      result("owner", "t6"),
      {
        type: "custom_message",
        customType: REPLICA_MESSAGE,
        details: { terminal: "t6", owner: "owner", final: true },
      },
    ];
    const ctx = {
      cwd: "/repo",
      ui: { setStatus() {} },
      sessionManager: { getBranch: () => branch },
    };
    h.watcher.restore(ctx as never);
    expect(h.watcher.count).toBe(1);
    await settle();
    expect(h.sent).toHaveLength(1);
    answer(replica, "new-after-reload");
    await until(() => h.sent.length === 2);
    expect(h.sent[1].content).toContain("new-after-reload");
    h.watcher.stopAll();
  });

  it("follows a persisted recovered helper once and remembers its closure across reloads", async () => {
    const h = harness({
      terminal: "t9",
      status: "done",
      reply: "fixture",
      listed: true,
      answers: true,
    });
    const branch: unknown[] = [
      {
        type: "custom_message",
        customType: "herdr-recovery",
        details: {
          helpers: [{ terminal: "t9", name: "fixture", owner: "owner", kind: "subagent" }],
        },
      },
    ];
    const ctx = {
      cwd: "/repo",
      ui: { setStatus() {} },
      sessionManager: { getBranch: () => branch },
    };
    h.watcher.restore(ctx as never);
    expect(h.watcher.count).toBe(1);
    h.watcher.reconcile(ctx as never);
    await until(() => h.sent.length === 1);
    expect(h.sent[0].details).toMatchObject({ terminal: "t9", kind: "subagent", status: "idle" });
    expect(h.watcher.count).toBe(1);
    h.watcher.closed("t9");
    branch.push({
      type: "custom",
      customType: REPLICA_CLOSED,
      data: { terminal: "t9", owner: "owner" },
    });
    branch.push({
      type: "custom_message",
      customType: "herdr-recovery",
      details: { helpers: [{ terminal: "t9", name: "fixture", owner: "owner", kind: "subagent" }] },
    });
    h.watcher.reconcile(ctx as never);
    expect(h.watcher.count).toBe(0);
    h.watcher.restore(ctx as never);
    expect(h.watcher.count).toBe(0);
    h.watcher.stopAll();
  });

  it("reports a followed replica that exited while the original reloaded as exited, not as failed to start", async () => {
    const h = harness({
      terminal: "t9",
      status: "exited",
      reply: "x",
      listed: true,
      answers: false,
    });
    h.watcher.follow({ terminal: "t9", name: "r", since: 0, restored: true }, "/repo");
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("herdr:t9");
    expect(h.sent[0].details).toMatchObject({ status: "exited", final: true });
  });

  it("reports a watch that broke instead of going quiet", async () => {
    const replica: Fake = {
      terminal: "t9",
      status: "working",
      reply: "x",
      listed: true,
      answers: true,
    };
    const h = harness(replica, "owner", async () => {
      throw new Error("settings unavailable");
    });
    h.watcher.follow({ terminal: "t9", name: "r", since: Date.now(), restored: false }, "/repo");
    await settle();
    replica.status = "done";
    answer(replica, "result");
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("settings unavailable");
    expect(h.sent[0].details).toMatchObject({ status: "failed", final: true });
    await until(() => h.watcher.count === 0);
  });

  it("includes the replica name and assignment", () => {
    const text = replicaAssignment("check-auth", "Check auth.");
    expect(text).toContain("check-auth");
    expect(text).toContain("Check auth.");
  });
});
