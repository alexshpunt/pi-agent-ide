import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

function events(args: Record<string, unknown>, mode: string, value = ""): RunEvent[] {
  const entries: RunEvent[] = [
    {
      type: "tool_execution_start",
      toolCallId: "diff",
      toolName: "diff",
      args,
      ...(mode === "codemode" && { parentToolCallId: "script" }),
    },
    {
      type: "tool_execution_end",
      toolCallId: "diff",
      toolName: "diff",
      isError: false,
      result: { content: [{ type: "text", text: value }], structuredContent: value },
    },
  ];
  return mode === "direct"
    ? entries
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...entries,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}

const discovery = capabilityCases.find((entry) => entry.id === "deferred-navigation-recovery");
const diff = discovery?.steps.find((step) => step.tool === "diff");
assert.ok(diff);

for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: path-only diff sources match strings without changing retained evidence`, () => {
    for (const before of ["task.ts", { path: "task.ts" }]) {
      for (const after of ["task.ts", { path: "task.ts" }]) {
        const retained = events({ before, after }, mode);
        const original = structuredClone(retained);
        assert.ok(validateRoute({ steps: [diff] }, retained, mode).passed);
        assert.deepEqual(retained, original);
        assert.ok(
          validateRoute(
            { steps: [{ tool: "diff", args: { before, after }, scriptResult: "" }] },
            events({ before: "task.ts", after: "task.ts" }, mode),
            mode,
          ).passed,
        );
      }
    }
  });

  void test(`${mode}: undefined source bounds mean omission in case requirements`, () => {
    const source = { path: "task.ts", offset: undefined, limit: undefined };
    for (const actual of ["task.ts", { path: "task.ts" }]) {
      assert.ok(
        validateRoute(
          { steps: [{ tool: "diff", args: { before: source, after: source } }] },
          events({ before: actual, after: actual }, mode),
          mode,
        ).passed,
      );
    }
    assert.equal(
      validateRoute(
        { steps: [{ tool: "diff", args: { before: source, after: source } }] },
        events({ before: { ...source, limit: 0 }, after: source }, mode),
        mode,
      ).passed,
      false,
    );
  });
  void test(`${mode}: diff sources use the existing file path equivalence`, () => {
    assert.ok(
      validateRoute(
        { steps: [diff] },
        events(
          {
            before: { path: "/workspace/fixture/task.ts" },
            after: "file:///workspace/fixture/task.ts",
          },
          mode,
        ),
        mode,
      ).passed,
    );
  });

  void test(`${mode}: unbounded diff sources do not match bounded or different sources`, () => {
    for (const field of ["before", "after"]) {
      for (const source of [
        "other.ts",
        { path: "other.ts" },
        { path: "task.ts", offset: 1 },
        { path: "task.ts", offset: 2 },
        { path: "task.ts", limit: 0 },
        { path: "task.ts", limit: 1 },
        { path: "task.ts", views: ["anchors"] },
        ["task.ts"],
      ]) {
        const changed = { before: "task.ts", after: "task.ts", [field]: source };
        for (const plain of ["task.ts", { path: "task.ts" }]) {
          const unbounded = { before: plain, after: plain };
          for (const [expected, actual] of [
            [unbounded, changed],
            [changed, unbounded],
          ] as const) {
            assert.equal(
              validateRoute(
                { steps: [{ tool: "diff", args: expected }] },
                events(actual, mode),
                mode,
              ).passed,
              false,
              JSON.stringify({ expected, actual }),
            );
          }
        }
      }
    }
  });

  void test(`${mode}: source equivalence preserves result and reuse checks`, () => {
    const args = { before: { path: "task.ts" }, after: { path: "task.ts" } };
    assert.equal(
      validateRoute({ steps: [diff] }, events(args, mode, "unexpected difference"), mode).passed,
      false,
    );
    const reused: RouteStep = { ...diff, reuse: { from: 0, field: "before" } };
    assert.equal(validateRoute({ steps: [reused] }, events(args, mode), mode).passed, false);
  });
}
