import { describe, expect, it } from "vitest";
import { HerdrService } from "#herdr/service.ts";
import { AgentWaiter, signature } from "#herdr/wait.ts";

type Fake = {
  terminal: string;
  status: string;
  state?: string;
  busy?: boolean;
  reply?: string;
  question?: string;
  vanished?: boolean;
};

/** A Herdr bridge whose agents change state as polls advance. */
function harness(
  agents: Fake[],
  options: {
    onList?: (poll: number) => void;
    fail?: (name: string, poll: number) => boolean;
    unavailable?: boolean;
  } = {},
) {
  let polls = 0;
  const calls: string[] = [];
  const events = {
    emit(_name: string, request: { provide(api: unknown): void }) {
      if (options.unavailable) return;
      request.provide({
        version: 1,
        async command(name: string, args: Record<string, unknown>) {
          calls.push(`${name}:${typeof args.terminal === "string" ? args.terminal : ""}`);
          if (name === "agent.list") {
            polls++;
            options.onList?.(polls);
          }
          if (options.fail?.(name, polls)) throw new Error("transient-fixture");
          if (name === "agent.list")
            return {
              agents: agents
                .filter((agent) => !agent.vanished)
                .map((agent) => ({
                  terminal: agent.terminal,
                  name: "fixture",
                  state: agent.state ?? "live",
                  status: agent.status,
                })),
            };
          if (name === "agent.inspect") {
            const agent = agents.find((item) => item.terminal.endsWith(String(args.terminal)));
            if (!agent || agent.vanished) throw new Error("No such terminal");
            return {
              terminal: args.terminal,
              name: "fixture",
              state: agent.state ?? "live",
              pid: 1,
              session: "s1",
              inspection: {
                busy: agent.busy ?? agent.status === "working",
                failed: agent.status === "error",
                omitted: { calls: 0, reasoning: 0 },
                ...(agent.question ? { pendingQuestion: agent.question } : {}),
                events: [
                  {
                    kind: "reply",
                    at: "2026-11-17T00:00:00Z",
                    text: agent.reply ?? `reply-of-${agent.terminal}`,
                  },
                ],
              },
            };
          }
          if (name === "agent.send") return { outcome: "submitted" };
          throw new Error(`unexpected ${name}`);
        },
      });
    },
  };
  const service = new HerdrService({ events } as never, () => "owner");
  const waiter = (budget = 3000, sendGraceMs = 5000, maxFailures = 3) =>
    new AgentWaiter(service, async () => budget, { pollMs: 1, sendGraceMs, maxFailures });
  return { service, waiter, calls, polls: () => polls };
}
const run = async (waiter: AgentWaiter, sources: string[]) =>
  waiter.run(await waiter.resolve(sources), new AbortController().signal, "/fixture");

describe("wait_for_agents waiter", () => {
  it("detects a changed question or error in a stopped agent", async () => {
    const agents: Fake[] = [{ terminal: "t7", status: "blocked", question: "first-question" }];
    const h = harness(agents);
    const targets = await h.waiter().resolve(["herdr:t7"]);
    const first = await h.service.inspect("herdr:t7");
    agents[0].question = "second-question";
    const second = await h.service.inspect("herdr:t7");
    const observation = (value: typeof first) => [{ target: targets[0], value }];
    expect(signature(observation(first))).not.toEqual(signature(observation(second)));
    const beforeError = signature(observation(second));
    second.inspection.lastError = "new-error";
    expect(beforeError).not.toEqual(signature(observation(second)));
  });
  it("waits until every agent stops and reports each timeline once", async () => {
    const agents: Fake[] = [
      { terminal: "laptop/t7", status: "working" },
      { terminal: "laptop/t8", status: "blocked", question: "question-fixture" },
    ];
    const h = harness(agents, {
      onList: (poll) => {
        if (poll === 4) agents[0].status = "done";
      },
    });
    const text = await run(h.waiter(), ["herdr:laptop/t7", "herdr:laptop/t8"]);
    expect(h.polls()).toBe(5);
    expect(text).toContain("herdr:laptop/t7");
    expect(text).toContain("idle");
    expect(text).toContain("reply-of-laptop/t7");
    expect(text).toContain("herdr:laptop/t8");
    expect(text).toContain("waiting");
    expect(text).toContain("question-fixture");
    // The result counts as a read: a later write is authorized and the reply is not repeated.
    expect(h.service.cursors.identity("owner", "laptop/t7")).toEqual({ pid: 1, session: "s1" });
    expect(await h.service.read("herdr:laptop/t7", 3000)).not.toContain("reply-of-laptop/t7");
  });

  it("keeps waiting while the list lags behind a busy Pi", async () => {
    const agents: Fake[] = [{ terminal: "t7", status: "done", busy: true }];
    const h = harness(agents, {
      onList: (poll) => {
        if (poll === 3) agents[0].busy = false;
      },
    });
    expect(await run(h.waiter(), ["herdr:t7"])).toContain("herdr:t7");
    expect(h.polls()).toBe(4);
  });

  it("waits for the reply to a message sent to an idle agent", async () => {
    const agents: Fake[] = [{ terminal: "t7", status: "done", reply: "old-reply" }];
    const h = harness(agents, {
      onList: (poll) => {
        if (poll === 3) agents[0].reply = "new-reply";
      },
    });
    await h.service.read("herdr:t7", 3000);
    await h.service.send("herdr:t7", "please continue");
    const text = await run(h.waiter(), ["herdr:t7"]);
    expect(h.polls()).toBe(4);
    expect(text).toContain("new-reply");
  });

  it("stops treating a send as pending once the agent worked on it or the grace period ends", async () => {
    const agents: Fake[] = [{ terminal: "t7", status: "done" }];
    const worked = harness(agents, {
      onList: (poll) => {
        agents[0].status = poll === 2 ? "working" : "done";
      },
    });
    await worked.service.read("herdr:t7", 3000);
    await worked.service.send("herdr:t7", "go");
    await run(worked.waiter(), ["herdr:t7"]);
    expect(worked.polls()).toBe(4);
    const silent = harness([{ terminal: "t7", status: "done" }]);
    await silent.service.read("herdr:t7", 3000);
    await silent.service.send("herdr:t7", "go");
    await run(silent.waiter(3000, 30), ["herdr:t7"]);
    expect(silent.polls()).toBeGreaterThan(1);
  });

  it("keeps waiting through a momentary idle state, such as a Pi reload", async () => {
    const agents: Fake[] = [{ terminal: "t7", status: "working", reply: "reload-gap" }];
    const h = harness(agents, {
      onList: (poll) => {
        agents[0].status = poll === 2 ? "done" : poll < 5 ? "working" : "done";
        if (poll >= 5) agents[0].reply = "final-reply";
      },
    });
    const text = await run(h.waiter(), ["herdr:t7"]);
    expect(h.polls()).toBe(6);
    expect(text).toContain("final-reply");
  });

  it("reports an agent that disappears as exited", async () => {
    const agents: Fake[] = [
      { terminal: "t7", status: "working" },
      { terminal: "t8", status: "done" },
    ];
    const h = harness(agents, {
      onList: (poll) => {
        if (poll === 2) agents[0].vanished = true;
      },
    });
    const text = await run(h.waiter(), ["herdr:t7", "herdr:t8"]);
    expect(text).toContain("herdr:t7");
    expect(text).toContain("exited");
    expect(text).toContain("herdr:t8");
    expect(text).toContain("idle");
  });

  it("shares the read budget across agents", async () => {
    const long = "start " + "x".repeat(5000) + " end";
    const agents: Fake[] = ["t7", "t8", "t9"].map((terminal) => ({
      terminal,
      status: "done",
      reply: long,
    }));
    const text = await run(harness(agents).waiter(3000), ["herdr:t7", "herdr:t8", "herdr:t9"]);
    for (const section of text.split("\n\n").slice(1, 4))
      expect(section.length).toBeLessThanOrEqual(1000 + "herdr:t7\n".length);
    expect(text.length).toBeLessThan(3600);
  });

  it("rejects unknown, ambiguous and history addresses before waiting", async () => {
    const h = harness([
      { terminal: "laptop/t7", status: "done" },
      { terminal: "pc/t7", status: "done" },
    ]);
    await expect(h.waiter().resolve(["herdr:t99"])).rejects.toThrow("HERDR_UNKNOWN_AGENT");
    await expect(h.waiter().resolve(["herdr:t7"])).rejects.toThrow("HERDR_AMBIGUOUS_ADDRESS");
    await expect(h.waiter().resolve(["herdr:laptop/t7/history"])).rejects.toThrow(
      "HERDR_INVALID_ADDRESS",
    );
    await expect(h.waiter().resolve([])).rejects.toThrow("HERDR_INVALID_TARGETS");
    expect((await h.waiter().resolve(["herdr:laptop/t7", "herdr:laptop/t7"])).length).toBe(1);
  });

  it("retries transient bridge errors and fails after repeated ones", async () => {
    const flaky = harness([{ terminal: "t7", status: "done" }], {
      fail: (name, poll) => name === "agent.list" && poll === 2,
    });
    const targets = await flaky.waiter().resolve(["herdr:t7"]);
    expect(await flaky.waiter().run(targets, new AbortController().signal, "/fixture")).toContain(
      "herdr:t7",
    );
    const broken = harness([{ terminal: "t7", status: "done" }], {
      fail: (name, poll) => name === "agent.list" && poll > 1,
    });
    const brokenTargets = await broken.waiter().resolve(["herdr:t7"]);
    await expect(
      broken.waiter().run(brokenTargets, new AbortController().signal, "/fixture"),
    ).rejects.toThrow(/HERDR_WAIT_FAILED.*transient-fixture/u);
    await expect(harness([], { unavailable: true }).waiter().resolve(["herdr:t7"])).rejects.toThrow(
      "HERDR_UNAVAILABLE",
    );
  });

  it("stops polling when cancelled", async () => {
    const h = harness([{ terminal: "t7", status: "working" }]);
    const controller = new AbortController();
    const waiting = h
      .waiter()
      .run(await h.waiter().resolve(["herdr:t7"]), controller.signal, "/fixture");
    setTimeout(() => controller.abort(new Error("cancel-fixture")), 20);
    await expect(waiting).rejects.toThrow("cancel-fixture");
    const polls = h.polls();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.polls()).toBe(polls);
  });
});
