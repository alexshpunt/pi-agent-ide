import { expect, test } from "vitest";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const task = capabilityCases.find((candidate) => candidate.id === "shell-roundtrip");
if (!task) throw new Error("Missing shell-roundtrip case");
const shell = "shell:abc123";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const result = (index: number) => `<uuid>${uuid(index)}</uuid>\n${shell}\nhello`;

function executions(
  mode: string,
  args: Record<string, unknown>,
  refusal = "This result has no reusable text selection.",
): RunEvent[] {
  const events: RunEvent[] = [];
  const parent = mode === "codemode" ? "script" : undefined;
  if (parent)
    events.push({ type: "tool_execution_start", toolCallId: parent, toolName: "codemode" });
  const call = (
    name: string,
    parameters: Record<string, unknown>,
    output: string,
    isError = false,
  ) => {
    const id = `call-${events.length}`;
    events.push(
      {
        type: "tool_execution_start",
        toolCallId: id,
        parentToolCallId: parent,
        toolName: name,
        args: parameters,
      },
      {
        type: "tool_execution_end",
        toolCallId: id,
        toolName: name,
        isError,
        result: { content: [{ type: "text", text: output }] },
      },
    );
  };
  call("bash", { command: "read value; printf '%s\\n' \"$value\"", background: true }, shell);
  call("write", { path: shell, content: "hello" }, result(1));
  call("insert", { path: shell, text: "Enter" }, result(2));
  call("read", { path: uuid(1) }, result(3));
  call("read", { path: uuid(2) }, result(4));
  call("read", { path: shell }, result(5));
  call("replace", args, refusal, true);
  call("search", { path: shell, query: "hello" }, "hello");
  call("search", { query: "process:pi" }, "process:42");
  call("read", { path: "process:42" }, "Pi process");
  call("delete", { path: shell }, "Shell removed");
  if (parent)
    events.push({
      type: "tool_execution_end",
      toolCallId: parent,
      toolName: "codemode",
      isError: false,
      result: { content: [{ type: "text", text: "hello" }] },
    });
  return events;
}

for (const mode of ["direct", "codemode"]) {
  test.each([false, true])(
    `${mode} accepts the authority refusal with complete payload=%s`,
    (complete) => {
      const args = { path: uuid(5), start: "hello", ...(complete ? { text: "BAD" } : {}) };
      expect(validateRoute(task, executions(mode, args), mode).passed).toBe(true);
    },
  );

  test.each([
    "Missing required payload: text",
    "Schema validation failed: text must be a string",
    "Unable to read target: ENOENT",
  ])(`${mode} rejects a different failure: %s`, (refusal) => {
    expect(
      validateRoute(task, executions(mode, { path: uuid(5), start: "hello" }, refusal), mode)
        .passed,
    ).toBe(false);
  });

  test(`${mode} rejects a raw-shell shortcut even with the correct refusal`, () => {
    expect(
      validateRoute(task, executions(mode, { path: shell, start: "hello", text: "BAD" }), mode)
        .passed,
    ).toBe(false);
  });

  test(`${mode} still requires reading the Insert result`, () => {
    const events = executions(mode, { path: uuid(5), start: "hello" });
    const read = events.find(
      (event) => event.type === "tool_execution_start" && event.args?.path === uuid(2),
    );
    if (!read) throw new Error("Missing Insert-result Read fixture");
    read.args = { path: uuid(1) };
    expect(validateRoute(task, events, mode).passed).toBe(false);
  });
}
