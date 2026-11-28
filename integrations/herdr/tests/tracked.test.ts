import { describe, expect, it } from "vitest";
import { HerdrService } from "#herdr/service.ts";

function harness() {
  const tracked: { name: string; args: Record<string, unknown>; toolCallId: string | null }[] = [];
  const ordinary: string[] = [];
  const inspection = {
    terminal: "m/t7",
    state: "live",
    pid: 1,
    session: "target",
    inspection: { busy: false, failed: false, omitted: { calls: 0, reasoning: 0 }, events: [] },
  };
  const response = (name: string) =>
    name === "agent.inspect"
      ? inspection
      : name === "agent.list"
        ? { agents: [] }
        : { outcome: "submitted" };
  const events = {
    emit(_name: string, request: { provide(api: unknown): void }) {
      request.provide({
        version: 1,
        async command(name: string) {
          ordinary.push(name);
          return response(name);
        },
        async commandTracked(
          name: string,
          args: Record<string, unknown>,
          options: { toolCallId: string | null },
        ) {
          tracked.push({ name, args, toolCallId: options.toolCallId });
          return { id: "request-fixture", revision: "revision-fixture", result: response(name) };
        },
      });
    },
  };
  return { service: new HerdrService({ events } as never, () => "owner"), tracked, ordinary };
}

describe("tracked Herdr calls", () => {
  it("tracks user-facing reads and mutations without tracking background inspection", async () => {
    const h = harness();
    await h.service.list();
    await h.service.read("herdr:m/t7", 3000);
    await h.service.send("herdr:m/t7", "message fixture");
    expect(h.ordinary).toEqual(["agent.list"]);
    expect(h.tracked.map(({ name, toolCallId }) => ({ name, toolCallId }))).toEqual([
      { name: "agent.inspect", toolCallId: null },
      { name: "agent.send", toolCallId: null },
    ]);
  });

  it("exposes the completed request revision for a read result", async () => {
    const h = harness();
    const receipts: { id: string; revision: string }[] = [];
    await h.service.read("herdr:m/t7", 3000, receipts);
    expect(receipts).toEqual([{ id: "request-fixture", revision: "revision-fixture" }]);
  });

  it("exposes the completed request ID for the persisted mutation result", async () => {
    const h = harness();
    await h.service.read("herdr:m/t7", 3000);
    const receipts: { id: string; revision: string }[] = [];
    await h.service.send("herdr:m/t7", "message fixture", receipts);
    expect(receipts).toEqual([{ id: "request-fixture", revision: "revision-fixture" }]);
  });

  it.each([
    ["queue", "HERDR_NOT_SUBMITTED"],
    ["app-version", "HERDR_RECOVERY_UNSUPPORTED"],
    ["storage", "HERDR_RECOVERY_STORAGE"],
  ])("classifies a non-submitted request caused by %s", async (reason, code) => {
    const events = {
      emit(_name: string, request: { provide(api: unknown): void }) {
        request.provide({
          version: 1,
          commandTracked: async () => {
            throw Object.assign(new Error("fixture"), {
              code: "HERDR_NOT_SUBMITTED",
              effect: "not-applied",
              reason,
            });
          },
        });
      },
    };
    const service = new HerdrService({ events } as never, () => "owner");
    await expect(service.command("agent.list", {}, "herdr:", null)).rejects.toMatchObject({
      code,
      effect: "not-applied",
    });
  });
  it("forwards an explicit tool call ID for a direct call", async () => {
    const h = harness();
    await h.service.command("agent.replicate", {}, "herdr:", "call-fixture");
    expect(h.tracked).toMatchObject([{ name: "agent.replicate", toolCallId: "call-fixture" }]);
  });
});
