import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type CapabilityCase, type RunEvent } from "./validation.ts";

function task(id: string): CapabilityCase {
  const found = capabilityCases.find((entry) => entry.id === id);
  assert.ok(found);
  return found;
}

function check(
  fixture: CapabilityCase,
  args: Record<string, unknown>[],
  groups: number[][],
  mode: string,
  receipts: Record<number, string> = {},
): boolean {
  const events: RunEvent[] = [];
  if (mode === "codemode")
    events.push({ type: "tool_execution_start", toolCallId: "script", toolName: "codemode" });
  for (const group of groups) {
    for (const index of group) {
      const step = fixture.steps[index];
      assert.ok(step);
      events.push({
        type: "tool_execution_start",
        toolCallId: String(index),
        toolName: step.tool,
        args: args[index],
        ...(mode === "codemode" && { parentToolCallId: "script" }),
      });
    }
    for (const index of group) {
      const step = fixture.steps[index];
      assert.ok(step);
      // The subject is scheduling. Supply each check's own payload so rewording feedback
      // cannot turn these route regressions into prose assertions.
      const text = [step.contains, receipts[index]].filter(Boolean).join("\n");
      events.push({
        type: "tool_execution_end",
        toolCallId: String(index),
        toolName: step.tool,
        isError: step.error === true,
        result: { content: [{ type: "text", text }] },
      });
    }
  }
  if (mode === "codemode")
    events.push({ type: "tool_execution_end", toolCallId: "script", isError: false });
  return validateRoute(fixture, events, mode).passed;
}

for (const mode of ["direct", "codemode"]) {
  void test(`independent Insert and Copy recoveries may overlap (${mode})`, () => {
    const fixture = task("missing-edit-selector-recovery");
    const args = [
      { path: "task.txt", text: "added" },
      { path: "task.txt" },
      { path: "task.txt", anchor: "OLD", text: "added" },
      { path: "task.txt", start: "OLD", target: "target.txt" },
      { path: "target.txt" },
      { path: "task.txt", start: "OLD", target: "target.txt", targetStart: "DEST" },
    ];
    assert.ok(check(fixture, args, [[0], [1], [2, 3], [4], [5]], mode));
    assert.ok(check(fixture, args, [[3], [4], [5], [0], [1], [2]], mode));
    assert.ok(!check(fixture, args, [[0, 1], [2, 3], [4], [5]], mode));
    assert.ok(!check(fixture, args, [[0], [1], [2, 3], [4, 5]], mode));
    assert.ok(!check(fixture, args, [[0], [1], [2, 3], [4]], mode));
  });

  void test(`debugger observations overlap without advancing or deleting their state (${mode})`, () => {
    const fixture = task("debug-controls");
    const resource = "debug:fixture";
    const source = `${resource}/source/task.py`;
    const args = [
      { adapter: "debugpy", program: "task.py" },
      { path: source, views: ["anchors"] },
      { path: source, text: "breakpoint", anchor: "D07BBXQ" },
      { path: source, views: ["breakpoints"] },
      { path: resource, text: "start" },
      { path: resource },
      { path: resource, text: "step into" },
      { path: resource },
      { path: resource, text: "step over" },
      { path: resource },
      { path: resource, text: "evaluate result" },
      { path: resource, text: "step out" },
      { path: resource },
      { path: `${resource}/breakpoint/one` },
      { path: resource },
      { path: resource, text: "continue" },
      { path: resource },
      { path: resource },
    ];
    const receipts = {
      0: resource,
      1: "D07BBXQ|answer = twice(value)",
      2: `${resource}/breakpoint/one`,
    };
    const groups = [
      [0],
      [1],
      [2],
      [3, 4],
      [5],
      [6],
      [7],
      [8],
      [9, 10],
      [11],
      [12, 13],
      [14],
      [15],
      [16],
      [17],
    ];
    assert.ok(check(fixture, args, groups, mode, receipts));
    for (const [earlier, later] of [
      [2, 3],
      [5, 6],
      [9, 11],
      [10, 11],
      [12, 15],
      [14, 15],
      [16, 17],
    ] as const) {
      const premature = groups.map((group) => group.filter((index) => index !== later));
      premature.find((group) => group.includes(earlier))?.push(later);
      assert.ok(!check(fixture, args, premature, mode, receipts));
    }
  });
}

void test("a standalone post-edit Read does not wait for unrelated refusals", () => {
  const fixture = task("standalone-resource-host");
  const readId = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
  const searchId = "RESULT#22222222-bbbb-4bbb-8bbb-222222222222";
  const args = [
    {},
    { path: "memory://demo/note", offset: 1, limit: 1 },
    { path: { id: readId }, query: "alpha" },
    { path: { id: searchId }, text: "changed" },
    { path: "local.txt" },
    { path: "memory://other/note" },
    { path: "memory://demo/note", target: "local.txt" },
    { path: "memory://demo/note" },
  ];
  const receipts = { 1: readId, 2: searchId };
  assert.ok(check(fixture, args, [[1], [2], [3], [7, 4, 5, 6]], "codemode", receipts));
  assert.ok(!check(fixture, args, [[1], [2], [3, 7], [4, 5, 6]], "codemode", receipts));
});
