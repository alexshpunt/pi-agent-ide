import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

const task = capabilityCases.find((entry) => entry.id === "shell-screen");
assert.ok(task);
const png = { type: "image", data: "fixture-png", mimeType: "image/png" };

function events(mode: string, view = "sequence:duration=2,interval=0.5", count = 5): RunEvent[] {
  const calls = [
    {
      id: "launch",
      tool: "bash",
      args: { command: "printf SCREEN-MARKER" },
      content: [{ type: "text", text: "shell:screen-1" }],
      value: { session: "shell:screen-1" },
    },
    {
      id: "still",
      tool: "read",
      args: { path: "shell:screen-1", views: ["image"] },
      content: [png],
      value: png,
    },
    {
      id: "capture-short",
      tool: "read",
      args: { path: "shell:screen-1", views: [view] },
      content: Array.from({ length: count }, () => png),
      value:
        count === 1 ? png : { type: "images", images: Array.from({ length: count }, () => png) },
    },
  ];
  const starts: RunEvent[] = calls.map((call) => ({
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.tool,
    args: call.args,
    ...(mode === "codemode" && { parentToolCallId: "script" }),
  }));
  const ends: RunEvent[] = calls.map((call) => ({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.tool,
    isError: false,
    result: { content: call.content, structuredContent: call.value },
  }));
  const [launchStart, stillStart, sequenceStart] = starts;
  const [launchEnd, stillEnd, sequenceEnd] = ends;
  assert.ok(launchStart && stillStart && sequenceStart && launchEnd && stillEnd && sequenceEnd);
  // Both captures belong to one assistant message and may overlap or finish in reverse order.
  const middle: RunEvent[] = [
    launchStart,
    launchEnd,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: calls.slice(1).map((call) => ({ type: "toolCall", id: call.id })),
      },
    },
    stillStart,
    sequenceStart,
    sequenceEnd,
    stillEnd,
  ];
  return mode === "direct"
    ? middle
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...middle,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}

for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: shell captures accept parameterized sequences in the same assistant message`, () => {
    for (const view of [
      "sequence",
      "sequence:duration=2,interval=0.5",
      "sequence:scale=0.25,interval=1,duration=2",
    ]) {
      const retained = events(mode, view, 3);
      const original = structuredClone(retained);
      assert.ok(validateRoute(task, retained, mode).passed);
      assert.deepEqual(retained, original);
      for (const id of ["launch", "still", "capture-short"])
        assert.equal(
          validateRoute(
            task,
            retained.filter((event) => event.toolCallId !== id),
            mode,
          ).passed,
          false,
        );
      for (const id of ["still", "capture-short"]) {
        const wrongSource = retained.map((event) =>
          event.type === "tool_execution_start" && event.toolCallId === id
            ? { ...event, args: { ...event.args, path: "shell:unrelated" } }
            : event,
        );
        assert.equal(validateRoute(task, wrongSource, mode).passed, false);
        const failed = retained.map((event) =>
          event.type === "tool_execution_end" && event.toolCallId === id
            ? { ...event, isError: true }
            : event,
        );
        assert.equal(validateRoute(task, failed, mode).passed, false);
      }
    }
  });

  void test(`${mode}: insufficient sequence frames identify the completed capture that fell short`, () => {
    // Reproduce the real successful Read: seconds, not milliseconds, give one PNG.
    const result = validateRoute(task, events(mode, "sequence:duration=2,interval=50", 1), mode);
    assert.equal(result.passed, false);
    assert.ok(
      result.reasons.some((reason) =>
        ["capture-short", "1", "2"].every((value) => reason.includes(value)),
      ),
    );
    const singleAsList = events(mode, "sequence", 1).map((event) =>
      event.toolCallId === "capture-short" && event.type === "tool_execution_end"
        ? {
            ...event,
            result: { ...event.result, structuredContent: { type: "images", images: [png] } },
          }
        : event,
    );
    assert.equal(validateRoute(task, singleAsList, mode).passed, false);
    assert.equal(validateRoute(task, events(mode, "sequence", 0), mode).passed, false);
    assert.equal(validateRoute(task, events(mode, "image", 3), mode).passed, false);
    const empty = events(mode).map((event) =>
      event.toolCallId === "capture-short" && event.type === "tool_execution_end"
        ? { ...event, result: { ...event.result, content: [], details: { frames: 5 } } }
        : event,
    );
    assert.equal(validateRoute(task, empty, mode).passed, false);
  });
}
