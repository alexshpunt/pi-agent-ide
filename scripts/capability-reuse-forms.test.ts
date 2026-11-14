import { describe, expect, test } from "vitest";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type CapabilityCase, type RunEvent } from "#capabilities/validation.ts";

interface Call {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  /** UUID of the enveloped result, as Pi Agent IDE prints it in the result text. */
  uuid?: string;
  text?: string;
  value?: unknown;
  error?: boolean;
  parent?: string;
}

function call({ id, tool, args = {}, uuid, text = "", value, error, parent }: Call) {
  const envelope = uuid ? `<uuid>${uuid}</uuid>\n` : "";
  return [
    {
      type: "tool_execution_start",
      toolCallId: id,
      toolName: tool,
      args,
      ...(parent && { parentToolCallId: parent }),
    },
    {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: tool,
      isError: error ?? false,
      result: {
        content: [{ type: "text", text: envelope + text }],
        ...(value !== undefined && { structuredContent: value }),
      },
    },
  ] satisfies RunEvent[];
}

/** One native Codemode script that runs the given calls in order. */
function script(id: string, calls: Omit<Call, "parent">[]): RunEvent[] {
  return [
    { type: "tool_execution_start", toolCallId: id, toolName: "codemode", args: {} },
    ...calls.flatMap((entry) => call({ ...entry, parent: id })),
    {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "codemode",
      isError: false,
      result: { content: [{ type: "text", text: "Script completed" }] },
    },
  ];
}

/** Direct calls that one assistant message issued together. */
function message(...ids: string[]): RunEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: ids.map((id) => ({ type: "toolCall", id })) },
  };
}

function capabilityCase(id: string): CapabilityCase {
  const found = capabilityCases.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing capability case ${id}`);
  return found;
}

const uuid = (digit: string) => `${digit.repeat(8)}-aaaa-4aaa-8aaa-${digit.repeat(12)}`;

describe("repeated-line-anchor-after-block-delete", () => {
  const task = capabilityCase("repeated-line-anchor-after-block-delete");
  const initial = call({
    id: "initial",
    tool: "read",
    args: { path: "task.txt", views: ["anchors"] },
    text: "ABCDEFG|template <typename T>\nHJKMNPQ|}\nRSTVWXY|template <typename T>",
  });
  const block = call({
    id: "block",
    tool: "delete",
    args: { path: "task.txt", start: "ABCDEFG", end: "HJKMNPQ" },
  });
  const stale = (error: boolean) =>
    call({
      id: "stale",
      tool: "delete",
      args: { path: "task.txt", start: "RSTVWXY" },
      error,
    });
  const fresh = call({
    id: "fresh",
    tool: "read",
    args: { path: "task.txt", views: ["anchors"] },
    text: "1234567|template <typename T>",
  });
  const recovery = (start = "1234567") =>
    call({
      id: "recovery",
      tool: "delete",
      args: { path: "task.txt", start },
    });
  const check = (events: RunEvent[]) => validateRoute(task, events, "direct").passed;

  test("accepts stale-anchor refusal followed by fresh-Read recovery", () => {
    expect(check([...initial, ...block, ...stale(true), ...fresh, ...recovery()])).toBe(true);
  });

  test("requires refusal of the old anchor", () => {
    expect(check([...initial, ...block, ...stale(false), ...fresh, ...recovery()])).toBe(false);
    expect(check([...initial, ...block, ...fresh, ...recovery()])).toBe(false);
  });

  test("requires a fresh Read before recovery", () => {
    expect(check([...initial, ...block, ...stale(true), ...recovery()])).toBe(false);
  });

  test.each(["RSTVWXY", "7654321", "template <typename T>"])(
    "rejects recovery with the unissued fresh selector %j",
    (start) => {
      expect(check([...initial, ...block, ...stale(true), ...fresh, ...recovery(start)])).toBe(
        false,
      );
    },
  );
});

describe("a reused result counts in every supported form", () => {
  const route = {
    steps: [{ tool: "read" }, { tool: "search", reuse: { from: 0, field: "path" } }],
  };
  const events = (path: unknown) => [
    ...call({ id: "read", tool: "read", args: { path: "task.txt" }, uuid: uuid("1") }),
    ...call({ id: "search", tool: "search", args: { path, query: "marker" } }),
  ];

  test.each([
    ["a bare UUID", uuid("1")],
    ["a RESULT# id", `RESULT#${uuid("1")}`],
    ["{ id } with a bare UUID", { id: uuid("1") }],
    ["{ id } with a RESULT# id", { id: `RESULT#${uuid("1")}` }],
  ])("accepts %s of the earlier result", (_form, path) => {
    expect(validateRoute(route, events(path), "direct")).toEqual({ passed: true, reasons: [] });
  });

  test.each([
    ["an explicit path", "task.txt"],
    ["{ id } of another result", { id: uuid("2") }],
    ["a RESULT# id of another result", `RESULT#${uuid("2")}`],
  ])("rejects %s instead of the earlier result", (_form, path) => {
    expect(validateRoute(route, events(path), "direct").passed).toBe(false);
  });
});

describe("write-hook-read", () => {
  const task = capabilityCase("write-hook-read");
  const flagged = {
    id: "flagged",
    tool: "write",
    args: { path: "review.txt", content: "WRITE_HOOK_BODY review\n" },
    uuid: uuid("1"),
    // The remark that the case requires in the flagged Write result.
    text: task.steps[0]?.contains,
    value: `RESULT#${uuid("1")}`,
  };
  const replayed = {
    ...flagged,
    id: "replayed",
    uuid: uuid("2"),
    text: "",
    value: `RESULT#${uuid("2")}`,
  };
  const read = (path: string) => ({
    id: "read",
    tool: "read",
    args: { path },
    uuid: uuid("3"),
    text: "WRITE_HOOK_BODY review\n",
  });

  test("accepts the Write value of the flagged write passed to Read in Codemode", () => {
    expect(
      validateRoute(task, script("one", [flagged, read(`RESULT#${uuid("1")}`)]), "codemode"),
    ).toEqual({ passed: true, reasons: [] });
    expect(
      validateRoute(
        task,
        [...script("first", [flagged]), ...script("second", [read(`RESULT#${uuid("1")}`)])],
        "codemode",
      ).passed,
    ).toBe(true);
  });

  test("rejects reading the value of a replayed write that carried no hook remark", () => {
    expect(
      validateRoute(
        task,
        [
          ...script("first", [flagged]),
          ...script("second", [replayed, read(`RESULT#${uuid("2")}`)]),
        ],
        "codemode",
      ).passed,
    ).toBe(false);
  });
});

describe("shell-roundtrip", () => {
  const task = capabilityCase("shell-roundtrip");
  const shell = "shell:0123abcd";
  const reread = uuid("4");
  const calls = (writeRead: Omit<Call, "parent">[]): Omit<Call, "parent">[] => [
    {
      id: "bash",
      tool: "bash",
      args: { command: "read line; echo $line", background: true },
      uuid: uuid("1"),
      text: `session: ${shell}\nstatus: running`,
      value: { output: "", session: shell },
    },
    {
      id: "write",
      tool: "write",
      args: { path: shell, content: "hello" },
      uuid: uuid("2"),
      value: null,
    },
    {
      id: "insert",
      tool: "insert",
      args: { path: shell, text: "Enter" },
      uuid: uuid("3"),
      value: null,
    },
    ...writeRead,
    {
      id: "read",
      tool: "read",
      args: { path: shell },
      uuid: reread,
      text: "output:\nhello",
      value: { text: "output:\nhello", id: `RESULT#${reread}` },
    },
    {
      id: "replace",
      tool: "replace",
      args: { path: { id: `RESULT#${reread}` }, start: "hello", text: "BAD" },
      text: task.steps.find((step) => step.tool === "replace")?.contains,
      error: true,
    },
    { id: "search", tool: "search", args: { path: shell, query: "hello" }, text: "hello" },
    { id: "delete", tool: "delete", args: { path: shell }, value: null },
  ];
  const resultReads = [
    { id: "read-write", tool: "read", args: { path: uuid("2") }, text: "hello" },
    { id: "read-insert", tool: "read", args: { path: { id: uuid("3") } }, text: "hello" },
  ];

  test("Codemode reads the shell itself, since terminal input resolves to null", () => {
    expect(validateRoute(task, script("one", calls([])), "codemode")).toEqual({
      passed: true,
      reasons: [],
    });
  });

  test("the direct route still reads the Write and Insert results", () => {
    const direct = (extra: Omit<Call, "parent">[]) => calls(extra).flatMap((entry) => call(entry));
    expect(validateRoute(task, direct(resultReads), "direct")).toEqual({
      passed: true,
      reasons: [],
    });
    expect(validateRoute(task, direct([]), "direct").passed).toBe(false);
  });

  test("the refused Replace must use the terminal Read result", () => {
    const other = calls([]).map((entry) =>
      entry.id === "replace"
        ? { ...entry, args: { ...entry.args, path: { id: uuid("9") } } }
        : entry,
    );
    expect(validateRoute(task, script("one", other), "codemode").passed).toBe(false);
  });
});

test("docs-search-status follows the prompt's order and accepts any query", () => {
  const task = capabilityCase("docs-search-status");
  // Calls in the prompt's order, with queries the prompt leaves to the model for refused scopes.
  const searches: { path: string; query: string; limit?: number; error?: boolean }[] = [
    { path: "docs:all", query: "regex:.", limit: 1 },
    { path: "docs:terminal", query: "regex:(?!)" },
    { path: "docs:", query: "anything", error: true },
    { path: "docs:lpt-723-missing", query: "anything", error: true },
  ];
  // Each result carries the outcome that the case requires for its scope.
  const outcome = (path: string) =>
    task.steps.find((step) => step.args?.path === path)?.contains ?? "";
  const events = (entries: typeof searches) =>
    entries.flatMap(({ error, ...args }, index) =>
      call({
        id: `search-${String(index)}`,
        tool: "search",
        args,
        text: outcome(args.path),
        error,
      }),
    );
  expect(validateRoute(task, events(searches), "direct")).toEqual({ passed: true, reasons: [] });
  expect(validateRoute(task, events(searches.slice(0, 3)), "direct").passed).toBe(false);
  expect(
    validateRoute(
      task,
      events(
        searches.map((entry) => (entry.path === "docs:" ? { ...entry, error: false } : entry)),
      ),
      "direct",
    ).passed,
  ).toBe(false);
});

describe("search-query", () => {
  const task = capabilityCase("search-query");
  const events = (path: unknown) =>
    script("one", [
      { id: "files", tool: "file_search", args: { pattern: "task*.txt" }, value: [path].flat() },
      {
        id: "boolean",
        tool: "search",
        args: { path, query: "alpha AND beta AND NOT skip" },
        text: "PASS-MARKER",
      },
      {
        id: "regex",
        tool: "search",
        args: { path, query: "regex:beta", wholeWord: true, caseSensitive: true, limit: 1 },
        text: "PASS-MARKER",
      },
    ]);

  test("accepts the file_search value of one file as the searched path", () => {
    expect(validateRoute(task, events(["task.txt"]), "codemode")).toEqual({
      passed: true,
      reasons: [],
    });
  });

  test("rejects a list that names another or a further file", () => {
    expect(validateRoute(task, events(["other.txt"]), "codemode").passed).toBe(false);
    expect(validateRoute(task, events(["task.txt", "task2.txt"]), "codemode").passed).toBe(false);
  });
});

describe("read-jq", () => {
  const task = capabilityCase("read-jq");
  const events = (path: unknown) => [
    ...call({
      id: "status",
      tool: "read",
      args: { path: "config.json", views: ["jq:.status"] },
      uuid: uuid("1"),
      text: '"ready"',
    }),
    ...call({
      id: "paged",
      tool: "read",
      args: { path, views: ["jq:.status, .untouched"], offset: 2, limit: 1 },
      text: "7",
    }),
  ];

  test.each([
    ["the explicit path", "config.json"],
    ["{ id } of the whole-file Read", { id: uuid("1") }],
  ])("accepts the paged query on %s", (_form, path) => {
    expect(validateRoute(task, events(path), "direct")).toEqual({ passed: true, reasons: [] });
  });

  test("rejects another source", () => {
    expect(validateRoute(task, events("other.json"), "direct").passed).toBe(false);
    expect(validateRoute(task, events({ id: uuid("2") }), "direct").passed).toBe(false);
  });
});

test("read-jq-bounded-input reads the first line with or without offset 1", () => {
  const task = capabilityCase("read-jq-bounded-input");
  const events = (window: Record<string, unknown>) => [
    ...call({
      id: "line",
      tool: "read",
      args: { path: "config.json", ...window },
      uuid: uuid("1"),
      text: "{",
    }),
    ...call({
      id: "bounded",
      tool: "read",
      args: { path: { id: uuid("1") }, views: ["jq:.status"] },
      text: "jq requires a complete JSON source",
      error: true,
    }),
    ...call({
      id: "explicit",
      tool: "read",
      args: { path: "config.json", views: ["jq:.status"] },
      text: '"ready"',
    }),
  ];
  expect(validateRoute(task, events({ limit: 1 }), "direct").passed).toBe(true);
  expect(validateRoute(task, events({ offset: 1, limit: 1 }), "direct").passed).toBe(true);
  expect(validateRoute(task, events({ offset: 2, limit: 1 }), "direct").passed).toBe(false);
});

describe("selection-batch-insert", () => {
  const task = capabilityCase("selection-batch-insert");
  const reads = [2, 4, 6].flatMap((line, index) =>
    call({
      id: `read-${String(index)}`,
      tool: "read",
      args: { path: "task.txt", offset: line, limit: 1 },
      uuid: uuid(String(index + 1)),
      text: "OLD",
    }),
  );
  const inserts = (text: string) =>
    [0, 1, 2].flatMap((index) =>
      call({
        id: `insert-${String(index)}`,
        tool: "insert",
        args: { path: { id: uuid(String(index + 1)) }, text, before: true },
      }),
    );
  const batch = message("insert-0", "insert-1", "insert-2");

  test.each(["ADDED", "ADDED\n"])("accepts %j before each selected line", (text) => {
    expect(validateRoute(task, [...reads, batch, ...inserts(text)], "direct")).toEqual({
      passed: true,
      reasons: [],
    });
  });

  test("still requires one assistant message for the batch", () => {
    expect(
      validateRoute(
        task,
        [
          ...reads,
          message("insert-0"),
          message("insert-1"),
          message("insert-2"),
          ...inserts("ADDED\n"),
        ],
        "direct",
      ).passed,
    ).toBe(false);
    expect(validateRoute(task, [...reads, batch, ...inserts("ADDED\n\n")], "direct").passed).toBe(
      false,
    );
  });
});
