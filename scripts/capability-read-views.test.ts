import { expect, test } from "vitest";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  result?: RunEvent["result"];
  isError?: boolean;
}

function executions(calls: Call[], mode: string): RunEvent[] {
  const parent = mode === "codemode" ? "script" : undefined;
  const events: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: String(index),
      parentToolCallId: parent,
      toolName: call.tool,
      args: call.args,
    },
    {
      type: "tool_execution_end",
      toolCallId: String(index),
      toolName: call.tool,
      isError: call.isError ?? false,
      result: call.result,
    },
  ]);
  return parent
    ? [
        { type: "tool_execution_start", toolCallId: parent, toolName: "codemode" },
        ...events,
        { type: "tool_execution_end", toolCallId: parent, toolName: "codemode", isError: false },
      ]
    : events;
}

for (const mode of ["direct", "codemode"]) {
  test(`${mode} matches unordered Read views against regex requirements without changing events`, () => {
    const task = {
      steps: [
        {
          tool: "read",
          args: { path: "task.txt", limit: 3, views: [/^sequence(?::|$)/u, "anchors"] },
        },
      ],
    };
    const args = {
      path: "task.txt",
      limit: 3,
      views: ["anchors", "sequence:duration=0.2,interval=0.1", "ast"],
    };
    const events = executions([{ tool: "read", args }], mode);
    const original = structuredClone(events);
    expect(validateRoute(task, events, mode).passed).toBe(true);
    expect(events).toEqual(original);
    for (const changed of [
      { ...args, views: ["anchors", "image"] },
      { ...args, views: ["sequence:duration=0.2,interval=0.1"] },
      { ...args, views: undefined },
      { ...args, path: "other.txt" },
      { ...args, limit: 4 },
    ]) {
      expect(
        validateRoute(task, executions([{ tool: "read", args: changed }], mode), mode).passed,
      ).toBe(false);
    }
  });

  test(`${mode} shell-screen accepts parameterized sequences and still requires images and shell reuse`, () => {
    const task = capabilityCases.find((candidate) => candidate.id === "shell-screen");
    if (!task) throw new Error("Missing shell-screen case");
    const shell = "shell:screen-test";
    const calls: Call[] = [
      {
        tool: "bash",
        args: { command: "printf 'SCREEN-MARKER\\n'" },
        result: { content: [{ type: "text", text: shell }], structuredContent: { session: shell } },
      },
      {
        tool: "read",
        args: { path: shell, views: ["image"] },
        result: {
          content: [{ type: "image" }],
          structuredContent: { type: "image", mimeType: "image/png" },
        },
      },
      {
        tool: "read",
        args: { path: shell, views: ["sequence:duration=0.2,interval=0.1"] },
        result: {
          content: [{ type: "image" }, { type: "image" }, { type: "image" }],
          structuredContent: { type: "images" },
        },
      },
    ];
    expect(validateRoute(task, executions(calls, mode), mode).passed).toBe(true);
    for (const change of [
      { args: { path: "shell:other", views: ["sequence:duration=0.2,interval=0.1"] } },
      { args: { path: shell, views: ["image"] } },
      { isError: true },
      {
        result: {
          content: [{ type: "text", text: "SCREEN-MARKER" }],
          structuredContent: { type: "images" },
        },
      },
      {
        result: {
          content: [{ type: "image" }],
          structuredContent: { type: "image", mimeType: "image/png" },
        },
      },
    ]) {
      const changed = calls.map((call, index) => (index === 2 ? { ...call, ...change } : call));
      expect(validateRoute(task, executions(changed, mode), mode).passed).toBe(false);
    }
    expect(validateRoute(task, executions(calls.slice(0, 2), mode), mode).passed).toBe(false);
    expect(validateRoute(task, executions(calls.slice(1), mode), mode).passed).toBe(false);
  });
}
