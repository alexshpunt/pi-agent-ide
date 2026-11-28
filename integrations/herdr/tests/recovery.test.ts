import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRecovery } from "#herdr/recovery.ts";

type Item = {
  id: string;
  session: string;
  operation: string;
  toolCallId: string | null;
  state: "pending" | "unknown" | "result" | "error";
  revision: string;
  recoverable?: boolean;
  result?: unknown;
  error?: unknown;
  evidence?: unknown;
};
type Draft = { type: string; customType: string; content: string; details: unknown };
type Response = { entries: Draft[] };
type Handler = (
  event: Record<string, unknown>,
  ctx: unknown,
) => Promise<Response | undefined> | Response | undefined;
afterEach(() => vi.useRealTimers());
function harness() {
  vi.useFakeTimers();
  let owner = "session-1";
  let persisted = true;
  let modernBridge = true;
  let items: Item[] = [];
  const entries: unknown[] = [];
  const handlers = new Map<string, Handler>();
  const ack = vi.fn(async (_request: unknown): Promise<unknown> => undefined);
  const list = vi.fn(async () => items);
  const sent: unknown[] = [];
  const signals: unknown[] = [];
  const bridge = { version: 1, recovery: { list, ack } };
  const pi = {
    registerMessageRenderer() {},
    on(name: string, callback: Handler) {
      handlers.set(name, callback);
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
    events: {
      emit(name: string, event: { provide: (value: unknown) => void }) {
        if (name === "herdr:recovery-persisted") signals.push(event);
        else event.provide(modernBridge ? bridge : { version: 1 });
      },
    },
  };
  const ctx = {
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => owner,
      getSessionFile: () => "fixture.jsonl",
      getBranch: () => entries,
    },
  };
  registerRecovery(pi as never, { pollMs: 1000, sessionFileExists: () => persisted });
  const invoke = async (event: string, payload: Record<string, unknown> = {}) =>
    handlers.get(event)?.(payload, ctx);
  return {
    ack,
    list,
    sent,
    entries,
    signals,
    invoke,
    setItems: (value: Item[]) => {
      items = value;
    },
    setModernBridge: (value: boolean) => {
      modernBridge = value;
    },
    setPersisted: (value: boolean) => {
      persisted = value;
    },
    setOwner: (value: string) => {
      owner = value;
    },
  };
}
const item = (state: Item["state"], revision: string): Item => ({
  id: "request-fixture",
  session: "session-1",
  operation: "agent.remove",
  toolCallId: null,
  state,
  revision,
  recoverable: true,
  ...(state === "result" ? { result: { fixture: "result-fixture" } } : {}),
});
describe("Herdr recovery delivery", () => {
  it("reports a recovered agent list without internal metadata or JSON", async () => {
    const h = harness();
    h.setItems([
      {
        ...item("result", "v1"),
        operation: "agent.list",
        result: {
          agents: [
            {
              terminal: "workstation/t9",
              name: "fixture-helper",
              state: "live",
              status: "working",
              pid: 847239,
              session: "private-session-fixture",
            },
          ],
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("workstation/t9");
    expect(content).toContain("fixture-helper");
    expect(content).not.toContain("847239");
    expect(content).not.toContain("private-session-fixture");
    expect(content).not.toContain('"agents"');
    expect(content).not.toContain("request-fixture");
    expect(content).not.toContain("v1");
    await h.invoke("session_shutdown");
  });

  it("retains a recovered helper address when its launch outcome is uncertain", async () => {
    const h = harness();
    h.setItems([
      {
        ...item("unknown", "v1"),
        operation: "agent.subagent",
        evidence: [{ state: "done", result: { terminal: "workstation/t9", pid: 847239 } }],
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("workstation/t9");
    expect(content).not.toContain("847239");
    expect(content).not.toContain('"state"');
    await h.invoke("session_shutdown");
  });
  it("reports a recovered inspection without its internal identity", async () => {
    const h = harness();
    h.setItems([
      {
        ...item("result", "v1"),
        operation: "agent.inspect",
        result: {
          terminal: "workstation/t9",
          state: "live",
          pid: 847239,
          session: "private-session-fixture",
          inspection: {
            busy: false,
            failed: false,
            pendingQuestion: "question-fixture",
            events: [{ kind: "reply", text: "reply-fixture" }],
          },
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("workstation/t9");
    expect(content).toContain("question-fixture");
    expect(content).toContain("reply-fixture");
    expect(content).not.toContain("private-session-fixture");
    expect(content).not.toContain("847239");
    expect(content).not.toContain('"inspection"');
    await h.invoke("session_shutdown");
  });

  it("keeps large inspection and history payloads out of the agent message", async () => {
    const h = harness();
    const raw = `{"internalLogFixture":"${"stack-frame-fixture ".repeat(4000)}"}`;
    h.setItems([
      {
        ...item("result", "v1"),
        id: "inspection",
        operation: "agent.inspect",
        result: {
          terminal: "workstation/t9",
          state: "live",
          screen: raw,
          inspection: {
            busy: false,
            failed: true,
            pendingQuestion: raw,
            lastError: raw,
            events: [{ kind: "reply", text: raw }],
          },
        },
      },
      {
        ...item("result", "v1"),
        id: "history",
        operation: "agent.history",
        result: {
          terminal: "workstation/t9",
          items: [
            { kind: "call", text: raw },
            { kind: "reply", text: raw },
          ],
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("herdr:workstation/t9");
    expect(content).not.toContain("internalLogFixture");
    expect(content).not.toContain("stack-frame-fixture");
    expect(content.length).toBeLessThan(1000);
    expect(response?.entries[0].details).toMatchObject({
      outcomes: [
        { result: { inspection: { pendingQuestion: raw } } },
        { result: { items: [{ text: raw }, { text: raw }] } },
      ],
    });
    await h.invoke("session_shutdown");
  });

  it("preserves bounded natural replies and directs the agent to the full history", async () => {
    const h = harness();
    const reply = `reply-start-fixture ${"natural sentence ".repeat(300)} reply-end-fixture`;
    h.setItems([
      {
        ...item("result", "v1"),
        operation: "agent.inspect",
        result: {
          terminal: "workstation/t9",
          state: "live",
          inspection: { busy: false, events: [{ kind: "reply", text: reply }] },
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("reply-start-fixture");
    expect(content).toContain("reply-end-fixture");
    expect(content).not.toContain(reply);
    expect(content).toContain("herdr:workstation/t9/history");
    expect(content.length).toBeLessThan(1000);
    await h.invoke("session_shutdown");
  });

  it("suppresses raw stack replies and points to history", async () => {
    const h = harness();
    const reply =
      "Error: internal-fixture\n    at operation (/private/path:4:5)\n    at main (/private/path:8:9)";
    h.setItems([
      {
        ...item("result", "v1"),
        operation: "agent.inspect",
        result: {
          terminal: "workstation/t9",
          state: "live",
          inspection: { busy: false, events: [{ kind: "reply", text: reply }] },
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).not.toContain("internal-fixture");
    expect(content).not.toContain("/private/path");
    expect(content).toContain("herdr:workstation/t9/history");
    await h.invoke("session_shutdown");
  });

  it("distinguishes empty history from results containing only tool calls", async () => {
    const render = async (items: unknown[]) => {
      const h = harness();
      h.setItems([
        {
          ...item("result", "v1"),
          operation: "agent.history",
          result: { terminal: "workstation/t9", items },
        },
      ]);
      await h.invoke("session_start");
      const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
      await h.invoke("session_shutdown");
      return response?.entries[0].content;
    };
    const calls = await render([{ kind: "call", text: "internal-arguments-fixture" }]);
    expect(calls).toContain("herdr:workstation/t9");
    expect(calls).not.toContain("internal-arguments-fixture");
    expect(calls).toBe(await render([{ kind: "reply", text: "reply-fixture" }]));
    expect(calls).not.toBe(await render([]));
  });

  it("retains an ordinary inspection question", async () => {
    const render = async (pendingQuestion?: string) => {
      const h = harness();
      h.setItems([
        {
          ...item("result", "v1"),
          operation: "agent.inspect",
          result: {
            terminal: "workstation/t9",
            state: "live",
            inspection: { busy: false, pendingQuestion },
          },
        },
      ]);
      await h.invoke("session_start");
      const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
      await h.invoke("session_shutdown");
      return response?.entries[0].content;
    };
    const question = await render("question-fixture");
    expect(question).toContain("herdr:workstation/t9");
    expect(question).toContain("question-fixture");
    expect(question).not.toBe(await render());
  });

  it("treats an error without proof of non-submission like an unknown effect", async () => {
    const render = async (value: Item) => {
      const h = harness();
      h.setItems([value]);
      await h.invoke("session_start");
      const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
      await h.invoke("session_shutdown");
      return response?.entries[0].content;
    };
    const uncertain = await render(item("unknown", "v1"));
    expect(await render({ ...item("error", "v2"), error: { effect: "unknown" } })).toBe(uncertain);
    expect(await render({ ...item("error", "v3"), error: {} })).toBe(uncertain);
    expect(await render({ ...item("error", "v4"), error: { effect: "not-applied" } })).not.toBe(
      uncertain,
    );
  });

  it("preserves uncertainty when a replica receipt explicitly says its outcome is unknown", async () => {
    const render = async (value: Item) => {
      const h = harness();
      h.setItems([value]);
      await h.invoke("session_start");
      const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
      await h.invoke("session_shutdown");
      return response?.entries[0].content;
    };
    const result = { terminal: "workstation/t9", outcome: "unknown" };
    const uncertain = await render({
      ...item("unknown", "v1"),
      operation: "agent.replicate",
      evidence: [{ result }],
    });
    const receipt = await render({ ...item("result", "v2"), operation: "agent.replicate", result });
    expect(receipt).toBe(uncertain);
    expect(receipt).toContain("herdr:workstation/t9");
  });

  it("reports a recovered message destination without internal identity", async () => {
    const h = harness();
    h.setItems([
      {
        ...item("result", "v1"),
        operation: "agent.send",
        result: {
          terminal: "workstation/t9",
          outcome: "submitted",
          pid: 847239,
          session: "private-session-fixture",
        },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const content = response?.entries[0].content ?? "";
    expect(content).toContain("workstation/t9");
    expect(content).not.toContain("847239");
    expect(content).not.toContain("private-session-fixture");
    expect(content).not.toContain('"outcome"');
    await h.invoke("session_shutdown");
  });

  it("retains full outcomes internally while delivering only their useful details", async () => {
    const h = harness();
    const result = {
      terminal: "workstation/t9",
      outcome: "pending",
      pid: 847239,
      session: "private-session-fixture",
    };
    h.setItems([{ ...item("result", "v1"), operation: "agent.subagent", result }]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    const entry = response?.entries[0];
    expect(entry?.content).toContain("workstation/t9");
    expect(entry?.content).not.toContain("private-session-fixture");
    expect(entry?.details).toMatchObject({ outcomes: [{ result }] });
    await h.invoke("session_shutdown");
  });

  it("persists the information needed to follow a recovered helper and signals only after persistence", async () => {
    const h = harness();
    h.setItems([
      { ...item("result", "v1"), operation: "agent.replicate", result: { terminal: "fixture/t9" } },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    if (!response) throw new Error("Missing delivery");
    expect(response.entries[0].details).toMatchObject({
      helpers: [{ terminal: "fixture/t9", kind: "replica", owner: "session-1" }],
    });
    expect(h.signals).toHaveLength(0);
    h.entries.push(response.entries[0]);
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.signals).toHaveLength(1);
    await h.invoke("session_shutdown");
  });
  it("does not follow an uncertain helper launch from its evidence", async () => {
    const h = harness();
    h.setItems([
      {
        ...item("unknown", "v1"),
        operation: "agent.replicate",
        result: { terminal: "fixture/t9" },
      },
    ]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    if (!response) throw new Error("Missing delivery");
    expect(response.entries[0].details).toMatchObject({ helpers: [] });
    await h.invoke("session_shutdown");
  });

  it("acknowledges only a persisted delivery, never a pending or merely proposed one", async () => {
    const h = harness();
    h.setItems([item("result", "v1"), { ...item("pending", "v2"), id: "pending-fixture" }]);
    await h.invoke("session_start");
    const outcome = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(outcome?.entries).toHaveLength(1);
    expect(JSON.stringify(outcome?.entries[0])).toContain("result-fixture");
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    expect(await h.invoke("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    if (!outcome) throw new Error("Missing delivery");
    h.entries.push(outcome.entries[0]);
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });
  it("delivers and acknowledges a terminal refusal without reporting success", async () => {
    const h = harness();
    h.setItems([
      { ...item("error", "v1"), error: { code: "HERDR_NOT_SUBMITTED", effect: "not-applied" } },
    ]);
    await h.invoke("session_start");
    const outcome = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(JSON.stringify(outcome?.entries)).toContain("HERDR_NOT_SUBMITTED");
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    if (!outcome) throw new Error("Missing delivery");
    h.entries.push(outcome.entries[0]);
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("does not acknowledge a session entry before the session file exists", async () => {
    const h = harness();
    h.setPersisted(false);
    h.setItems([item("result", "v1")]);
    await h.invoke("session_start");
    const response = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    if (!response) throw new Error("Missing delivery");
    h.entries.push(response.entries[0]);
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    h.setPersisted(true);
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("still delivers other results if an acknowledgement must be retried", async () => {
    const h = harness();
    h.setItems([item("result", "v1"), { ...item("result", "v2"), id: "next-fixture" }]);
    h.entries.push({
      type: "custom_message",
      customType: "herdr-recovery",
      details: { items: [{ id: "request-fixture", revision: "v1" }] },
    });
    h.ack.mockRejectedValueOnce(new Error("fixture-error"));
    await h.invoke("session_start");
    const result = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(JSON.stringify(result?.entries)).toContain("next-fixture");
    await h.invoke("session_shutdown");
  });

  it("retries a proposal that never reached session history", async () => {
    const h = harness();
    h.setItems([item("result", "v1")]);
    await h.invoke("session_start");
    expect(await h.invoke("turn_end", { entries: [], outcome: "completed" })).toBeDefined();
    await vi.advanceTimersByTimeAsync(5100);
    expect(h.sent).toHaveLength(1);
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("delivers a later revision and never exposes another session's result", async () => {
    const h = harness();
    h.setItems([item("unknown", "v1")]);
    await h.invoke("session_start");
    const first = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    if (!first) throw new Error("Missing delivery");
    h.entries.push(first.entries[0]);
    h.setItems([
      item("result", "v2"),
      { ...item("result", "other"), id: "other-fixture", session: "session-2" },
    ]);
    const next = await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v2" }] });
    expect(JSON.stringify(next?.entries)).toContain("result-fixture");
    expect(JSON.stringify(next?.entries)).not.toContain("other-fixture");
    await h.invoke("session_shutdown");
  });
  it("does not deliver or acknowledge when the session changes during a list", async () => {
    const h = harness();
    let resolve: (items: Item[]) => void = () => {};
    h.list.mockImplementationOnce(
      () =>
        new Promise<Item[]>((done) => {
          resolve = done;
        }),
    );
    await h.invoke("session_start");
    const collecting = h.invoke("turn_end", { entries: [], outcome: "completed" });
    await Promise.resolve();
    h.setOwner("session-2");
    resolve([item("result", "v1")]);
    expect(await collecting).toBeUndefined();
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("does not let a late acknowledgement from a switched session block the new session", async () => {
    const h = harness();
    h.setItems([item("result", "v1")]);
    h.entries.push({
      type: "custom_message",
      customType: "herdr-recovery",
      details: { items: [{ id: "request-fixture", revision: "v1" }] },
    });
    let finish: () => void = () => {};
    h.ack.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await h.invoke("session_start");
    const old = h.invoke("turn_end", { entries: [], outcome: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ack).toHaveBeenCalledTimes(1);
    await h.invoke("session_shutdown");
    h.setOwner("session-2");
    h.setItems([{ ...item("result", "v2"), session: "session-2", id: "new-fixture" }]);
    await h.invoke("session_start");
    const next = h.invoke("turn_end", { entries: [], outcome: "completed" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.ack).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((await next)?.entries)).toContain("new-fixture");
    finish();
    expect(await old).toBeUndefined();
    await h.invoke("session_shutdown");
  });

  it("does not clear a new session's queued wake when an old acknowledgement fails", async () => {
    const h = harness();
    h.setItems([item("result", "v1")]);
    let fail: (error: Error) => void = () => {};
    h.ack.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await h.invoke("session_start");
    await vi.advanceTimersByTimeAsync(1000);
    await h.invoke("session_shutdown");
    h.setOwner("session-2");
    h.setItems([{ ...item("result", "v2"), session: "session-2", id: "new-fixture" }]);
    await h.invoke("session_start");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent).toHaveLength(1);
    fail(new Error("old-fixture"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent).toHaveLength(1);
    await h.invoke("session_shutdown");
  });

  it("wakes at most once while an idle delivery is queued", async () => {
    const h = harness();
    h.setItems([item("result", "v1")]);
    await h.invoke("session_start");
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.sent).toHaveLength(1);
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("acknowledges exact tool-result receipt markers, not lookalike metadata", async () => {
    const h = harness();
    h.setItems([
      { ...item("result", "v1"), recoverable: false },
      { ...item("result", "v2"), id: "unmarked", recoverable: false },
    ]);
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: false,
        toolName: "write",
        details: {
          metadata: {
            semanticAction: {
              source: "herdr:fixture/t1",
              herdrReceipts: [{ id: "request-fixture", revision: "v1" }],
            },
          },
        },
      },
    });
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: false,
        details: { other: { herdrReceipts: [{ id: "unmarked", revision: "v2" }] } },
      },
    });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("accepts a delete semantic action from a Herdr source", async () => {
    const h = harness();
    h.setItems([{ ...item("result", "v1"), recoverable: false }]);
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: false,
        toolName: "delete",
        details: {
          metadata: {
            semanticAction: {
              source: "herdr:fixture/t1",
              herdrReceipts: [{ id: "request-fixture", revision: "v1" }],
            },
          },
        },
      },
    });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("accepts the direct helper marker only for matching successful result revisions", async () => {
    const h = harness();
    h.setItems([
      { ...item("result", "v1"), recoverable: false },
      { ...item("unknown", "v2"), id: "unknown-fixture", recoverable: false },
      { ...item("result", "v3"), id: "failed-fixture", recoverable: false },
    ]);
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: false,
        toolName: "replicate",
        details: {
          herdrReceipts: [
            { id: "request-fixture", revision: "v1" },
            { id: "unknown-fixture", revision: "v2" },
          ],
        },
      },
    });
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: true,
        details: { herdrReceipts: [{ id: "failed-fixture", revision: "v3" }] },
      },
    });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it("accepts receipts from multi-resource Read details", async () => {
    const h = harness();
    h.setItems([{ ...item("result", "v1"), recoverable: false }]);
    h.entries.push({
      type: "message",
      message: {
        role: "toolResult",
        isError: false,
        toolName: "read",
        details: {
          resources: [
            {
              details: {
                source: "herdr:fixture/t1",
                resolvedBy: "herdr",
                herdrReceipts: [{ id: "request-fixture", revision: "v1" }],
              },
            },
          ],
        },
      },
    });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });

  it.each(["read", "search", "replicate", "subagent"])(
    "accepts direct receipts only from %s",
    async (toolName) => {
      const h = harness();
      h.setItems([{ ...item("result", "v1"), recoverable: false }]);
      h.entries.push({
        type: "message",
        message: {
          role: "toolResult",
          isError: false,
          toolName,
          details: {
            source: "herdr:fixture/t1",
            resolvedBy: "herdr",
            herdrReceipts: [{ id: "request-fixture", revision: "v1" }],
          },
        },
      });
      await h.invoke("session_start");
      await h.invoke("turn_end", { entries: [], outcome: "completed" });
      expect(h.ack).toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
      await h.invoke("session_shutdown");
    },
  );

  it("rejects markers from other tools, mismatched resources and wrong semantic-action tools", async () => {
    const h = harness();
    h.setItems([{ ...item("result", "v1"), recoverable: false }]);
    const receipt = [{ id: "request-fixture", revision: "v1" }];
    for (const [toolName, details] of [
      ["bash", { herdrReceipts: receipt }],
      ["search", { source: "elsewhere", herdrReceipts: receipt }],
      ["read", { source: "herdr:fixture/t1", resolvedBy: "foreign", herdrReceipts: receipt }],
      ["read", { resources: [{ details: { source: "elsewhere", herdrReceipts: receipt } }] }],
      [
        "read",
        { metadata: { semanticAction: { source: "herdr:fixture/t1", herdrReceipts: receipt } } },
      ],
      ["delete", { metadata: { semanticAction: { source: "elsewhere", herdrReceipts: receipt } } }],
    ] as const)
      h.entries.push({
        type: "message",
        message: { role: "toolResult", toolName, isError: false, details },
      });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).not.toHaveBeenCalledWith({ items: receipt });
    await h.invoke("session_shutdown");
  });

  it("retries deferred cleanup on every reconciliation even without deliveries", async () => {
    const h = harness();
    h.ack.mockRejectedValueOnce(new Error("fixture-error"));
    h.ack.mockResolvedValueOnce({ cleanupPending: [{ id: "cleanup-fixture", error: "fixture" }] });
    await h.invoke("session_start");
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    await h.invoke("turn_end", { entries: [], outcome: "completed" });
    expect(h.ack).toHaveBeenNthCalledWith(1, { items: [] });
    expect(h.ack).toHaveBeenNthCalledWith(2, { items: [] });
    expect(h.sent).toHaveLength(0);
    await h.invoke("session_shutdown");
  });

  it("ignores an older bridge without recovery support", async () => {
    const h = harness();
    h.setModernBridge(false);
    await h.invoke("session_start");
    expect(await h.invoke("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.sent).toHaveLength(0);
    await h.invoke("session_shutdown");
  });

  it("does not deliver or wake for live results without an explicit recoverable flag", async () => {
    const h = harness();
    h.setItems([
      { ...item("result", "v1"), recoverable: false },
      { ...item("result", "v2"), id: "missing-flag", recoverable: undefined },
    ]);
    await h.invoke("session_start");
    expect(await h.invoke("turn_end", { entries: [], outcome: "completed" })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.sent).toHaveLength(0);
    expect(h.ack).not.toHaveBeenCalledWith({ items: [{ id: "request-fixture", revision: "v1" }] });
    await h.invoke("session_shutdown");
  });
});
