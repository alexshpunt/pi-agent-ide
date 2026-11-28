import { describe, expect, it } from "vitest";
import { ReplicaWatcher, type ReplicaMessageDetails } from "#herdr/replicate.ts";
import { HerdrService, PROFILES, address, profilesText } from "#herdr/service.ts";
import { overlaps, registerSubagent } from "#herdr/subagent.ts";
import { AgentWaiter } from "#herdr/wait.ts";

type Reply = Record<string, unknown> | Error;
/** A Herdr bridge that answers each command from `replies` and records what it was asked. */
function harness(replies: Partial<Record<string, (args: Record<string, unknown>) => Reply>>) {
  const calls: [string, Record<string, unknown>][] = [];
  const events = {
    emit(_name: string, request: { provide(api: unknown): void }) {
      request.provide({
        version: 1,
        async command(name: string, args: Record<string, unknown>) {
          calls.push([name, args]);
          const reply = replies[name]?.(args);
          if (!reply) throw new Error(`unexpected ${name}`);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      });
    },
  };
  const service = new HerdrService({ events } as never, () => "owner");
  const waiter = new AgentWaiter(service, async () => 3000, {
    pollMs: 1,
    sendGraceMs: 5000,
    maxFailures: 50,
  });
  const sent: { content: string; details: ReplicaMessageDetails }[] = [];
  let tool:
    | {
        execute(
          id: string,
          params: Record<string, unknown>,
          signal: undefined,
          update: undefined,
          ctx: unknown,
        ): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
      }
    | undefined;
  const pi = {
    sendMessage(message: { content: string; details: ReplicaMessageDetails }) {
      sent.push(message);
    },
    appendEntry() {},
    registerTool(definition: typeof tool) {
      tool = definition;
    },
  };
  const watcher = new ReplicaWatcher(pi as never, waiter, () => "owner", {
    startupMs: 2000,
    restoreMs: 200,
  });
  registerSubagent(pi as never, watcher, () => "owner");
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } };
  const run = (params: Record<string, unknown>, id = "call-1") => {
    if (!tool) throw new Error("Subagent tool was not registered");
    return tool.execute(id, params, undefined, undefined, ctx);
  };
  return { service, watcher, sent, calls, run };
}
const live = (terminal: string, status = "working") => ({
  agents: [{ terminal, name: "research", state: "live", status }],
});
const timeline = (terminal: string, reply: string) => ({
  terminal,
  name: "research",
  state: "live",
  pid: 7,
  session: "sub",
  inspection: {
    busy: false,
    failed: false,
    omitted: { calls: 0, reasoning: 0 },
    events: [{ kind: "reply", at: new Date(Date.now() + 5).toISOString(), text: reply }],
  },
});
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe("workflow profiles", () => {
  it("lists each profile and its details", () => {
    const text = profilesText([
      {
        id: "feature",
        name: "Features",
        description: "New features and changes",
        model: "anthropic/opus",
        thinking: "high",
        fallbackModel: "openai/sol",
      },
      { id: "research", name: "Research", model: "openai/terra", thinking: "low" },
    ]);
    for (const value of [
      "feature",
      "Features",
      "New features and changes",
      "anthropic/opus",
      "high",
      "openai/sol",
      "research",
      "Research",
      "openai/terra",
      "low",
    ])
      expect(text).toContain(value);
  });

  it("reads herdr:profiles fresh from Herdr each time and refuses to change it", async () => {
    let profiles = [{ id: "feature", name: "Features", model: "p/a", thinking: "high" }];
    const h = harness({ "workflow.get": () => ({ version: 1, profiles }) });
    expect(await h.service.read(PROFILES, 3000)).toContain("p/a");
    profiles = [...profiles, { id: "research", name: "Research", model: "p/b", thinking: "low" }];
    expect(await h.service.read(PROFILES, 3000)).toContain("p/b");
    expect(() => address(PROFILES)).toThrow(/UNSUPPORTED_OPERATION/u);
    await expect(h.service.send(PROFILES, "hi")).rejects.toThrow(/UNSUPPORTED_OPERATION/u);
  });
});

describe("subagent", () => {
  it("starts a fresh agent with the chosen profile next to the caller and follows it until it stops", async () => {
    let reply = "thinking";
    const h = harness({
      "agent.subagent": () => ({
        outcome: "started",
        terminal: "laptop/t5",
        tab: "laptop/tb5",
        space: "laptop/sp1",
        model: "p/b",
      }),
      "agent.list": () => live("laptop/t5", reply === "found it" ? "done" : "working"),
      "agent.inspect": () => timeline("laptop/t5", reply),
      "agent.send": () => ({ outcome: "submitted" }),
    });
    const result = await h.run({
      name: "research-tooltips",
      task: "Find how GPUI shows tooltips.",
      profile: "research",
    });
    expect(result.content[0].text).toContain("herdr:laptop/t5");
    expect(result.details).toMatchObject({
      terminal: "laptop/t5",
      name: "research-tooltips",
      owner: "owner",
      kind: "subagent",
      profile: "research",
      model: "p/b",
      folder: "/repo",
    });
    const [name, args] = h.calls[0];
    expect(name).toBe("agent.subagent");
    // A retried call reuses its launch receipt: the key is the session and the tool call.
    expect(args).toMatchObject({
      requestId: "subagent-session-1-call-1",
      name: "research-tooltips",
      folder: "/repo",
      profile: "research",
    });
    expect(String(args.task)).toContain("research-tooltips");
    expect(String(args.task)).toContain("Find how GPUI shows tooltips.");
    expect(h.watcher.count).toBe(1);
    reply = "found it";
    await until(() => h.sent.length === 1);
    expect(h.sent[0].content).toContain("herdr:laptop/t5");
    expect(h.sent[0].content).toContain("found it");
    expect(h.sent[0].details).toMatchObject({ kind: "subagent", status: "idle", final: false });
    // The caller steers its sub-agent without reading it first.
    h.service.cursors.forget("owner", "laptop/t5");
    await h.service.send("herdr:laptop/t5", "Also check popovers.");
    expect(h.calls.find(([name]) => name === "agent.send")?.[1]).toMatchObject({
      terminal: "laptop/t5",
      message: "Also check popovers.",
      pid: 7,
      session: "sub",
    });
    h.watcher.stopAll();
  });

  it("lets a sub-agent ask the user only with askUser and reports its wait for the answer", async () => {
    let question: string | undefined;
    const replies = () => ({
      "agent.subagent": () => ({ outcome: "started", terminal: "t5" }),
      "agent.list": () => live("t5", question ? "blocked" : "working"),
      "agent.inspect": () => {
        const value = timeline("t5", "Drafted the task.");
        return { ...value, inspection: { ...value.inspection, pendingQuestion: question } };
      },
    });
    const quiet = harness(replies());
    const plain = await quiet.run({ name: "plain", task: "x", profile: "feature" });
    quiet.watcher.stopAll();
    expect(String(quiet.calls[0][1].task)).not.toContain("ask_user");
    expect(plain.details.askUser).toBeUndefined();
    const h = harness(replies());
    const asking = await h.run({ name: "manager", task: "x", profile: "feature", askUser: true });
    expect(String(h.calls[0][1].task)).toContain("ask_user");
    expect(asking.details).toMatchObject({ name: "manager", askUser: true });
    question = "Accept LPT-1 as written?";
    await until(() => h.sent.length === 1);
    expect(h.sent[0].details).toMatchObject({ status: "waiting", final: false });
    expect(h.sent[0].content).toContain("Accept LPT-1 as written?");
    h.watcher.stopAll();
  });

  it("follows this session's sub-agents again after a reload", async () => {
    const h = harness({
      "agent.list": () => live("t5", "done"),
      "agent.inspect": () => timeline("t5", "after-reload"),
    });
    const branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          isError: false,
          details: { terminal: "t5", name: "research", owner: "owner", since: 0, kind: "subagent" },
        },
      },
    ];
    h.watcher.restore({
      cwd: "/repo",
      ui: { setStatus() {} },
      sessionManager: { getBranch: () => branch },
    } as never);
    expect(h.watcher.count).toBe(1);
    await until(() => h.sent.length === 1);
    expect(h.sent[0].details).toMatchObject({ terminal: "t5", name: "research", status: "idle" });
    h.watcher.stopAll();
  });

  it("passes a separate folder and detects overlapping folders", async () => {
    const h = harness({
      "agent.subagent": () => ({ outcome: "started", terminal: "t5" }),
      "agent.list": () => live("t5"),
      "agent.inspect": () => timeline("t5", "x"),
    });
    await h.run({ name: "side", task: "Look around.", profile: "feature", folder: "/elsewhere" });
    expect(h.calls[0][1]).toMatchObject({ folder: "/elsewhere" });
    // A folder inside the caller's, or one that holds it, shares the caller's working tree.
    expect([
      overlaps("/repo", "/repo"),
      overlaps("/repo/pkg", "/repo"),
      overlaps("/", "/repo"),
      overlaps("/repo2", "/repo"),
      overlaps("/repo/..x", "/repo"),
    ]).toEqual([true, true, true, false, true]);
    h.watcher.stopAll();
  });

  it("names the reason when Herdr starts nothing", async () => {
    const refusal = (message: string) => harness({ "agent.subagent": () => new Error(message) });
    await expect(
      refusal(
        "agent.subagent refused: this agent is a replica or sub-agent at nesting depth 3, and nesting stops at depth 3. Do this work yourself.",
      ).run({ name: "side", task: "x", profile: "feature" }),
    ).rejects.toThrow(/^HERDR_NESTING_LIMIT/u);
    await expect(
      refusal(
        "agent.subagent refused: Unknown workflow profile research. Current profiles: feature, bug. Read herdr:profiles for what each is for.",
      ).run({ name: "side", task: "x", profile: "research" }),
    ).rejects.toThrow(/^HERDR_UNKNOWN_PROFILE/u);
    await expect(
      refusal("Unsupported Herdr bridge command").run({
        name: "side",
        task: "x",
        profile: "feature",
      }),
    ).rejects.toThrow(/^HERDR_SUBAGENT_UNSUPPORTED/u);
    await expect(
      refusal("Core request timed out; its effect is unknown.").run({
        name: "side",
        task: "x",
        profile: "feature",
      }),
    ).rejects.toThrow(/^HERDR_SUBAGENT_FAILED/u);
    await expect(
      harness({}).run({ name: "side", task: "x", profile: "feature", folder: "relative" }),
    ).rejects.toThrow(/^HERDR_INVALID_FOLDER/u);
  });

  it("reports a sub-agent whose model failed at startup and leaves it to the caller to close", async () => {
    const h = harness({
      "agent.subagent": () => ({
        outcome: "model-failed",
        terminal: "t5",
        detail: "quota exceeded",
      }),
      "agent.remove": () => ({ outcome: "removed" }),
      "agent.list": () => live("t5", "error"),
      "agent.inspect": () => timeline("t5", "x"),
    });
    await expect(h.run({ name: "side", task: "x", profile: "feature" })).rejects.toThrow(
      /^HERDR_SUBAGENT_NOT_STARTED/u,
    );
    expect(h.watcher.count).toBe(0);
    // It is still the caller's: delete needs no prior read.
    await h.service.remove("herdr:t5");
    expect(h.calls.map(([name]) => name)).toContain("agent.remove");
  });
});
