import { describe, expect, it } from "vitest";
import { HerdrService } from "#herdr/service.ts";

/** A Herdr bridge with one agent whose agent.remove reply the test chooses. */
function harness(remove: () => unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const events = {
    emit(_name: string, request: { provide(api: unknown): void }) {
      request.provide({
        version: 1,
        async command(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          if (name === "agent.inspect")
            return {
              terminal: args.terminal,
              name: "fixture",
              state: "live",
              pid: 1,
              session: "s1",
              inspection: {
                busy: false,
                failed: false,
                omitted: { calls: 0, reasoning: 0 },
                events: [{ kind: "reply", at: "2026-11-17T00:00:00Z", text: "reply-fixture" }],
              },
            };
          if (name === "agent.remove") return remove();
          if (name === "agent.send") return { outcome: "submitted" };
          throw new Error(`unexpected ${name}`);
        },
      });
    },
  };
  return { service: new HerdrService({ events } as never, () => "owner"), calls };
}
const fail = (message: string) => () => {
  throw new Error(message);
};

describe("closing a Herdr agent", () => {
  it("requires a read in this session", async () => {
    const h = harness(() => ({ outcome: "removed" }));
    await expect(h.service.remove("herdr:m/t7")).rejects.toMatchObject({
      code: "HERDR_READ_FIRST",
      effect: "not-applied",
    });
    expect(h.calls.some((call) => call.name === "agent.remove")).toBe(false);
  });

  it("removes the identity it read and forgets it afterwards", async () => {
    const h = harness(() => ({ outcome: "removed" }));
    await h.service.read("herdr:m/t7", 3000);
    await h.service.remove("herdr:m/t7");
    expect(h.calls.find((call) => call.name === "agent.remove")?.args).toEqual({
      terminal: "m/t7",
      pid: 1,
      session: "s1",
    });
    // A replacement Pi in the same terminal needs its own read before a message or another delete.
    await expect(h.service.send("herdr:m/t7", "hello")).rejects.toMatchObject({
      code: "HERDR_READ_FIRST",
    });
    await expect(h.service.remove("herdr:m/t7")).rejects.toMatchObject({
      code: "HERDR_READ_FIRST",
    });
  });

  it.each([
    [
      "The agent PID or session changed. Inspect it and use the current identity.",
      "HERDR_STALE_TARGET",
      "not-applied",
    ],
    [
      "No current Pi identity in this terminal. Inspect it before acting.",
      "HERDR_STALE_TARGET",
      "not-applied",
    ],
    [
      "Do not manage the calling Pi through its own Herdr agent tool.",
      "HERDR_DELETE_SELF",
      "not-applied",
    ],
    [
      "Remove only an agent in its own single-pane tab; split tabs and unrelated panes are preserved.",
      "HERDR_DELETE_SPLIT_TAB",
      "not-applied",
    ],
    ["Unsupported Herdr bridge command", "HERDR_DELETE_UNSUPPORTED", "not-applied"],
    ["Cannot inspect m/t7: terminal not found", "HERDR_UNKNOWN_AGENT", "not-applied"],
    ["The terminal is still live; its tab was retained.", "HERDR_DELETE_FAILED", "unknown"],
  ])('reports "%s" as %s', async (message, code, effect) => {
    const h = harness(fail(message));
    await h.service.read("herdr:m/t7", 3000);
    const error = await h.service.remove("herdr:m/t7").catch((value: unknown) => value);
    expect(error).toMatchObject({ code, effect });
    // A failed delete keeps the read, so the agent can be inspected and messaged again.
    await expect(h.service.send("herdr:m/t7", "hello")).resolves.toBeUndefined();
  });

  it.each([
    ["HERDR_NOT_SUBMITTED", "not-applied"],
    ["HERDR_OUTCOME_UNKNOWN", "unknown"],
  ])("preserves the bridge's structured %s outcome", async (code, effect) => {
    const h = harness(() => {
      throw Object.assign(new Error("fixture"), { code, effect, requestId: "request-fixture" });
    });
    await h.service.read("herdr:m/t7", 3000);
    await expect(h.service.remove("herdr:m/t7")).rejects.toMatchObject({ code, effect });
  });

  it("does not treat a malformed bridge refusal as proof that the operation was not applied", async () => {
    const h = harness(() => {
      throw Object.assign(new Error("fixture"), {
        code: "HERDR_NOT_SUBMITTED",
        effect: "unknown",
      });
    });
    await h.service.read("herdr:m/t7", 3000);
    await expect(h.service.remove("herdr:m/t7")).rejects.toMatchObject({
      code: "HERDR_DELETE_FAILED",
      effect: "unknown",
    });
  });

  it("rejects history addresses", async () => {
    await expect(harness(() => ({})).service.remove("herdr:m/t7/history")).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
  });
});
