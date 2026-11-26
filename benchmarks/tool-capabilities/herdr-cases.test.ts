import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RunEvent } from "./validation.ts";

function events(
  calls: { tool: string; args: Record<string, unknown>; text?: string }[],
  mode: string,
): RunEvent[] {
  const rows: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: String(index),
      toolName: call.tool,
      args: call.args,
      ...(mode === "codemode" ? { parentToolCallId: "script" } : {}),
    },
    {
      type: "tool_execution_end",
      toolCallId: String(index),
      toolName: call.tool,
      isError: false,
      result: { content: [{ type: "text", text: call.text ?? "" }] },
    },
  ]);
  return mode === "direct"
    ? rows
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...rows,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}
void test("Herdr wait route needs a listed agent and its reply", () => {
  const task = capabilityCases.find((item) => item.id === "herdr-wait");
  assert.ok(task);
  const list = { tool: "read", args: { path: "herdr:" }, text: "fixture/t7" };
  const wait = {
    tool: "wait_for_agents",
    args: { path: "herdr:fixture/t7" },
    text: "fixture-reply",
  };
  assert.ok(validateRoute(task, events([list, wait], "codemode"), "codemode").passed);
  assert.ok(!validateRoute(task, events([wait, list], "codemode"), "codemode").passed);
});
for (const mode of ["direct", "codemode"]) {
  void test(`Herdr launch routes require launch and close (${mode})`, () => {
    for (const kind of ["subagent", "replica"] as const) {
      const task = capabilityCases.find((item) => item.id === `herdr-${kind}`);
      assert.ok(task);
      const launch =
        kind === "subagent"
          ? {
              tool: "subagent",
              args: { name: "check-fixture", task: "Inspect the fixture", profile: "research" },
              text: "herdr:fixture/t9",
            }
          : {
              tool: "replicate",
              args: { name: "check-fixture", task: "Inspect the fixture" },
              text: "herdr:fixture/t9",
            };
      const prefix =
        kind === "subagent"
          ? [{ tool: "read", args: { path: "herdr:profiles" }, text: "research" }]
          : [];
      const send =
        kind === "replica"
          ? [{ tool: "write", args: { path: "herdr:fixture/t9", content: "hello-fixture" } }]
          : [];
      const close = { tool: "delete", args: { path: "herdr:fixture/t9" } };
      const calls = [...prefix, launch, ...send, close];
      assert.ok(validateRoute(task, events(calls, mode), mode).passed);
      assert.ok(!validateRoute(task, events(calls.slice(0, -1), mode), mode).passed);
    }
  });
  void test(`Herdr message route checks the target and order (${mode})`, () => {
    const task = capabilityCases.find((item) => item.id === "herdr-message");
    assert.ok(task);
    const list = { tool: "read", args: { path: "herdr:" }, text: "fixture/t7" };
    const read = { tool: "read", args: { path: "herdr:fixture/t7" }, text: "fixture-reply" };
    const send = { tool: "write", args: { path: "herdr:fixture/t7", content: "hello-fixture" } };
    const calls = [list, read, send];
    assert.ok(validateRoute(task, events(calls, mode), mode).passed);
    assert.ok(!validateRoute(task, events([list, send, read], mode), mode).passed);
    assert.ok(
      !validateRoute(
        task,
        events(
          [list, read, { ...send, args: { path: "herdr:fixture/t8", content: "hello-fixture" } }],
          mode,
        ),
        mode,
      ).passed,
    );
  });
}
