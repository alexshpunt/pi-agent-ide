import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateFiles } from "#capabilities/sandbox.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";

const task = capabilityCases.find(({ id }) => id === "codemode-search-anchor-batch");
assert.ok(task);
const start = (
  id: string,
  toolName: string,
  args: Record<string, unknown> = {},
  parentToolCallId = "script",
): RunEvent => ({ type: "tool_execution_start", toolCallId: id, toolName, args, parentToolCallId });
const end = (id: string, text = "", isError = false): RunEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  isError,
  result: { content: [{ type: "text", text }] },
});
const reference = (index: number, session = "ABC123", kind = "line") =>
  `SEARCH#${session}:${index}:${kind}`;
const searchText = `${reference(1)} beta\n${reference(2)} gamma`;
const batch = (...ids: string[]) => ({ applied: true, calls: ids.map((id) => ({ id })) });
function trace(text = "BETA\n"): RunEvent[] {
  return [
    { ...start("script", "codemode"), parentToolCallId: undefined },
    start("search", "search", { path: "task.txt", query: "regex:beta|gamma" }),
    end("search", searchText),
    start("read", "read", { path: ".pi/issued-search.txt" }),
    end("read", searchText),
    start("insert", "insert", {
      path: "task.txt",
      anchor: "alpha",
      before: true,
      newText: "added\n",
    }),
    start("replace", "replace", { start: reference(1), text }),
    start("delete", "delete", { start: reference(2) }),
    end("insert"),
    end("replace"),
    end("delete"),
    {
      ...end("script"),
      result: { details: { editorBatches: [batch("insert", "replace", "delete")] } },
    },
  ];
}
const check = (events: RunEvent[]) => validateRoute(task, events, "codemode").passed;
const changeStart = (events: RunEvent[], id: string, args: Record<string, unknown>) =>
  events.map((event) =>
    event.type === "tool_execution_start" && event.toolCallId === id
      ? { ...event, args: { ...event.args, ...args } }
      : event,
  );

test.each(["BETA", "BETA\n"])(
  "Search value batch accepts outcome-controlled payload %j",
  (text) => {
    const valueTask = capabilityCases.find(({ id }) => id === "codemode-search-value-batch");
    assert.ok(valueTask);
    const id = "RESULT#06755bc0-a0c2-480a-a770-630b3d4db3df";
    const events = trace(text)
      .filter((event) => event.toolCallId !== "read")
      .map((event) => {
        if (event.toolCallId === "search") {
          if (event.type === "tool_execution_start")
            return { ...event, args: { path: "task.txt", query: "beta" } };
          return {
            ...event,
            result: {
              structuredContent: {
                complete: true,
                matches: [{ id, path: "task.txt", line: 2, text: "beta", lineText: "beta" }],
              },
            },
          };
        }
        if (event.toolCallId === "replace" && event.type === "tool_execution_start")
          return { ...event, args: { path: { id }, text } };
        if (event.toolCallId === "delete" && event.type === "tool_execution_start")
          return { ...event, args: { path: "task.txt", start: "gamma" } };
        return event;
      });
    expect(validateRoute(valueTask, events, "codemode").passed).toBe(true);
    expect(
      validateRoute(valueTask, changeStart(events, "replace", { path: "task.txt" }), "codemode")
        .passed,
    ).toBe(false);
  },
);
describe("Search anchor batch payloads", () => {
  test.each(["BETA", "BETA\n"])("accepts a line replacement payload %j", (text) => {
    expect(check(trace(text))).toBe(true);
  });

  test.each([
    ["insert", { before: false }],
    ["insert", { anchor: "omega" }],
    ["replace", { path: "task.txt" }],
    ["delete", { path: "task.txt" }],
    ["replace", { start: reference(1, "DEAD") }],
    ["delete", { start: reference(2, "DEAD") }],
    ["replace", { start: reference(1, "ABC123", "match") }],
    ["replace", { start: "RESULT#06755bc0-a0c2-480a-a770-630b3d4db3df" }],
    ["replace", { start: "beta" }],
    ["delete", { start: reference(1) }],
  ] as const)("rejects changed selector or path on %s (%#)", (id, args) => {
    expect(check(changeStart(trace("BETA"), id, args))).toBe(false);
  });

  test.each(["search", "read", "insert", "replace", "delete", "script"])(
    "requires the completed %s execution",
    (id) => {
      expect(check(trace().filter((event) => event.toolCallId !== id))).toBe(false);
      expect(
        check(
          trace().filter(
            (event) => !(event.toolCallId === id && event.type === "tool_execution_end"),
          ),
        ),
      ).toBe(false);
      expect(
        check(
          trace().map((event) =>
            event.toolCallId === id && event.type === "tool_execution_end"
              ? { ...event, isError: true }
              : event,
          ),
        ),
      ).toBe(false);
    },
  );

  test("requires the edits to belong to one native parent", () => {
    const events = trace("BETA");
    events.unshift({ ...start("other", "codemode"), parentToolCallId: undefined });
    expect(
      check(
        events.map((event) =>
          event.toolCallId === "replace" && event.type === "tool_execution_start"
            ? { ...event, parentToolCallId: "other" }
            : event,
        ),
      ),
    ).toBe(false);
  });
  test("requires a completed issuer before its selectors are consumed", () => {
    const events = trace("BETA");
    const issuer = events.splice(2, 1)[0];
    assert.ok(issuer);
    events.splice(-1, 0, issuer);
    expect(check(events)).toBe(false);
  });

  test.each([
    undefined,
    [batch("insert", "replace")],
    [{ ...batch("insert", "replace", "delete"), applied: false }],
    [batch("insert", "replace", "other")],
    [batch("insert", "a", "b"), batch("replace", "c", "d"), batch("delete", "e", "f")],
    [batch("insert", "replace", "a"), batch("replace", "delete", "b")],
  ])("requires all three edits in the same committed batch (%#)", (editorBatches) => {
    expect(
      check(
        trace("BETA").map((event) =>
          event.toolCallId === "script" && event.type === "tool_execution_end"
            ? { ...event, result: { details: { editorBatches } } }
            : event,
        ),
      ),
    ).toBe(false);
  });

  test("rejects sequential edits even with an asserted batch receipt", () => {
    const events = trace("BETA");
    const insertEnd = events.splice(8, 1)[0];
    assert.ok(insertEnd);
    events.splice(6, 0, insertEnd);
    expect(check(events)).toBe(false);
  });

  test.each([
    "added\nalpha\nBETA\nomega\n",
    "added\nalpha\nBETA\n\nomega\n",
    "added\nalpha\nBETA\nomega",
    "added\nalpha\nBETA\nomega\nextra\n",
    "added\nalpha\nbeta\nomega\n",
    "added\nalpha\nBETA\ngamma\nomega\n",
    "added\nalpha\nBETA\nOMEGA\n",
  ])("checks complete final bytes independently of payload spelling (%#)", async (actual) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "capability-payload-"));
    try {
      await writeFile(path.join(cwd, "task.txt"), actual);
      const problems = await validateFiles(
        cwd,
        { "task.txt": Buffer.from("alpha\nbeta\ngamma\nomega\n") },
        task.expected,
      );
      expect(problems.length === 0).toBe(actual === "added\nalpha\nBETA\nomega\n");
      await writeFile(path.join(cwd, "unexpected.txt"), "unexpected\n");
      expect((await validateFiles(cwd, {}, task.expected)).length).toBeGreaterThan(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
