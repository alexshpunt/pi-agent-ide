import { describe, expect, it } from "vitest";
import {
  agentStatusOf,
  statusOf,
  renderTimeline,
  ReadCursor,
  cut,
  budgetValue,
  type Inspection,
} from "../src/timeline.ts";

const reply = "Reply fixture: beginning\n" + "context ".repeat(500) + "\nReply fixture: end";
const inspection = (extra: Partial<Inspection> = {}): Inspection => ({
  terminal: "t7",
  name: "fixture-agent",
  state: "live",
  pid: 42,
  session: "target-A",
  inspection: {
    busy: false,
    failed: false,
    omitted: { calls: 0, reasoning: 0 },
    events: [
      { kind: "reply", at: "2026-11-16T01:00:00Z", text: reply },
      { kind: "reasoning", at: "2026-11-16T01:01:00Z", text: "reason-fixture" },
      {
        kind: "call",
        at: "2026-11-16T01:02:00Z",
        tool: "fixture-tool",
        summary: "fixture-path",
        state: "running",
      },
    ],
  },
  ...extra,
});

describe("agent timeline", () => {
  it("maps list status and lifecycle into the timeline vocabulary", () => {
    for (const [status, expected] of [
      ["working", "working"],
      ["blocked", "waiting"],
      ["error", "error"],
      ["done", "idle"],
      ["idle", "idle"],
      ["exited", "exited"],
      [undefined, "idle"],
    ]) {
      expect(agentStatusOf({ state: "live", status })).toBe(expected);
    }
    expect(agentStatusOf({ state: "ended", status: "working" })).toBe("exited");
    expect(agentStatusOf({ state: "live", status: "working", exited: true })).toBe("exited");
  });
  it("applies lifecycle, question, busy and failure priority", () => {
    const value = inspection();
    expect(statusOf(value)).toBe("idle");
    value.inspection.failed = true;
    expect(statusOf(value)).toBe("error");
    value.inspection.busy = true;
    expect(statusOf(value)).toBe("working");
    value.inspection.pendingQuestion = "question-fixture";
    expect(statusOf(value)).toBe("waiting");
    expect(statusOf({ ...value, status: "exited" })).toBe("exited");
    value.state = "exited";
    expect(statusOf(value)).toBe("exited");
  });
  it("preserves multiline reply data and chronological steps when they fit", () => {
    const text = renderTimeline(inspection(), 10000);
    expect(text).toContain(reply);
    expect(text.indexOf("reason-fixture")).toBeGreaterThan(text.indexOf("Reply fixture: end"));
    expect(text.indexOf("fixture-tool")).toBeGreaterThan(text.indexOf("reason-fixture"));
  });
  it("cuts idle steps before the reply, retaining both reply ends", () => {
    const text = renderTimeline(inspection(), 500);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).not.toContain("fixture-tool");
    expect(text).not.toContain("reason-fixture");
    expect(text).toContain("Reply fixture: beginning");
    expect(text).toContain("Reply fixture: end");
  });
  it("retains current work at the minimum timeline budget", () => {
    const value = inspection();
    value.inspection.busy = true;
    const text = renderTimeline(value, 500);
    expect(text.length).toBeLessThanOrEqual(500);
    for (const marker of [
      "reason-fixture",
      "fixture-tool",
      "Reply fixture: beginning",
      "Reply fixture: end",
    ])
      expect(text).toContain(marker);
  });
  it("keeps current work ahead of an older long reply", () => {
    const value = inspection();
    value.inspection.busy = true;
    const text = renderTimeline(value, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("fixture-tool");
    expect(text).toContain("reason-fixture");
    expect(text).toContain("Reply fixture: end");
    expect(text).not.toContain(reply);
  });
  it("preserves question, options and error when the timeline is reduced", () => {
    const value = inspection();
    value.inspection.pendingQuestion = "question-fixture\noption-fixture";
    value.inspection.lastError = "error-fixture";
    const text = renderTimeline(value, 500);
    for (const fixture of ["question-fixture", "option-fixture", "error-fixture", "fixture-agent"])
      expect(text).toContain(fixture);
    expect(text.length).toBeLessThanOrEqual(500);
  });
  it("bounds oversized mandatory fields and removes terminal control sequences", () => {
    const value = inspection({ name: "name-head" + "n".repeat(1000) + "name-tail" });
    value.inspection.pendingQuestion =
      "\u001b[31mquestion-head" + "q".repeat(12000) + "question-tail\u001b[0m";
    value.inspection.lastError = "error-head" + "e".repeat(12000) + "error-tail";
    const rendered = renderTimeline(value, 500);
    expect(rendered.length).toBeLessThanOrEqual(500);
    for (const marker of [
      "name-head",
      "name-tail",
      "question-head",
      "question-tail",
      "error-head",
      "error-tail",
    ])
      expect(rendered).toContain(marker);
    expect(rendered).not.toContain("\u001b");
  });
  it("keeps cut Unicode well-formed and validates the configured budget bounds", () => {
    const input = "🧪".repeat(1000);
    for (const ceiling of [40, 41, 150, 500]) {
      const output = cut(input, ceiling);
      expect(output.length).toBeLessThanOrEqual(ceiling);
      expect(output).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    for (const valid of ["500", "3000", "20000"]) expect(budgetValue(valid)).toBe(Number(valid));
    for (const invalid of ["499", "20001", "3.5", " 500", "", undefined, 500])
      expect(() => budgetValue(invalid)).toThrow();
  });
  it("omits repeated replies only for the same owner, terminal and target identity", () => {
    const cursor = new ReadCursor();
    const value = inspection();
    expect(cursor.unchanged("owner-A", value)).toBe(false);
    cursor.record("owner-A", value);
    expect(cursor.unchanged("owner-A", value)).toBe(true);
    expect(cursor.unchanged("owner-B", value)).toBe(false);
    expect(cursor.unchanged("owner-A", { ...value, session: "target-B" })).toBe(false);
    expect(cursor.identity("owner-A", "t7")).toEqual({ pid: 42, session: "target-A" });
    value.inspection.events[0] = {
      kind: "reply",
      at: "2026-11-16T01:00:00Z",
      text: "changed-fixture",
    };
    expect(cursor.unchanged("owner-A", value)).toBe(false);
  });
});
