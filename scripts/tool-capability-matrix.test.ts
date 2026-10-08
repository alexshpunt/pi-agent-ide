import { execFileSync } from "node:child_process";
import { executeFileOperation } from "#pi-agent-text-editor/core/file-operations.js";
import { mkdir, mkdtemp, readFile, rm, writeFile, access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupTrial,
  prepareTrial,
  runProcess,
  sandboxArgs,
  validateFiles,
} from "#capabilities/sandbox.ts";
import { capabilityCases } from "#capabilities/cases.ts";
import { describe, expect, test } from "vitest";
import {
  checkCoverage,
  validateRoute,
  parseEvents,
  schemaShape,
} from "#capabilities/validation.ts";

const result = "<uuid>9b901a2b-a965-4729-8abb-3c09c3cbc6c2</uuid>\n1 marker";
const events = [
  { type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "task.txt" } },
  {
    type: "tool_execution_end",
    toolCallId: "r",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: result }] },
  },
  {
    type: "tool_execution_start",
    toolCallId: "s",
    toolName: "search",
    args: { path: result, query: "marker" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "s",
    toolName: "search",
    isError: false,
    result: { content: [{ type: "text", text: "found marker" }] },
  },
];
const task = { steps: [{ tool: "read" }, { tool: "search", reuse: { from: 0, field: "path" } }] };

describe("capability route evidence", () => {
  test("silent Write requires a completed parent without the child file body", () => {
    const route = { steps: [{ tool: "write", parentExcludes: "FILE_BODY" }] };
    const child = [
      { type: "tool_execution_start", toolCallId: "parent", toolName: "codemode" },
      {
        type: "tool_execution_start",
        toolCallId: "child",
        parentToolCallId: "parent",
        toolName: "write",
      },
      {
        type: "tool_execution_end",
        toolCallId: "child",
        isError: false,
        result: { content: [{ type: "text", text: "FILE_BODY" }] },
      },
    ];
    const parent = (output: string) => ({
      type: "tool_execution_end",
      toolCallId: "parent",
      isError: false,
      result: { content: [{ type: "text", text: output }] },
    });
    expect(validateRoute(route, [...child, parent("Script completed")], "codemode").passed).toBe(
      true,
    );
    expect(
      validateRoute(route, [...child, parent("Script completed FILE_BODY")], "codemode").passed,
    ).toBe(false);
    expect(validateRoute(route, child, "codemode").passed).toBe(false);
    expect(
      validateRoute(route, [...child, { ...parent("Script failed"), isError: true }], "codemode")
        .passed,
    ).toBe(false);
  });
  test("requires actual result reuse, not just the same tool names", () => {
    expect(validateRoute(task, events, "direct")).toEqual({ passed: true, reasons: [] });
    const bypass = events.map((event) =>
      event.toolCallId === "s" && event.type === "tool_execution_start"
        ? { ...event, args: { path: "task.txt", query: "marker" } }
        : event,
    );
    expect(validateRoute(task, bypass, "direct").passed).toBe(false);
  });

  test("accepts fixture path spellings and returned selectors, not invented references", () => {
    const readOnly = { steps: [{ tool: "read", args: { path: "task.txt" } }] };
    const absolute = events.map((event) =>
      event.toolCallId === "r" && event.type === "tool_execution_start"
        ? { ...event, args: { path: "/workspace/fixture/task.txt" } }
        : event,
    );
    expect(validateRoute(readOnly, absolute, "direct").passed).toBe(true);
    expect(
      validateRoute(
        readOnly,
        absolute.map((event) =>
          event.toolCallId === "r" && event.type === "tool_execution_start"
            ? { ...event, args: { path: "/workspace/fixture/other.txt" } }
            : event,
        ),
        "direct",
      ).passed,
    ).toBe(false);
    const selector = "SEARCH#ABCD:1:line";
    const anchored = events.map((event) =>
      event.toolCallId === "r" && event.type === "tool_execution_end"
        ? { ...event, result: { content: [{ type: "text", text: selector }] } }
        : event.toolCallId === "s" && event.type === "tool_execution_start"
          ? { ...event, toolName: "insert", args: { path: selector } }
          : event,
    );
    const route = {
      steps: [
        { tool: "read" },
        { tool: "insert", reuse: { from: 0, field: ["anchor", "path"], kind: "anchor" } },
      ],
    };
    expect(validateRoute(route, anchored, "direct").passed).toBe(true);
    expect(
      validateRoute(
        route,
        anchored.map((event) =>
          event.toolCallId === "s" && event.type === "tool_execution_start"
            ? { ...event, args: { path: "SEARCH#AAAA:1:line" } }
            : event,
        ),
        "direct",
      ).passed,
    ).toBe(false);
    expect(
      validateRoute(
        task,
        events.map((event) =>
          event.toolCallId === "r" && event.type === "tool_execution_end"
            ? {
                ...event,
                result: {
                  content: [{ type: "text", text: "RESULT#9b901a2b-a965-4729-8abb-3c09c3cbc6c2" }],
                },
              }
            : event.toolCallId === "s" && event.type === "tool_execution_start"
              ? { ...event, args: { path: "RESULT#9b901a2b-a965-4729-8abb-3c09c3cbc6c2" } }
              : event,
        ),
        "direct",
      ).passed,
    ).toBe(true);
  });
  test("accepts only reviewed argument alternatives without weakening result reuse", () => {
    const route = {
      steps: [
        { tool: "read" },
        {
          tool: "search",
          args: { query: "marker" },
          argsAny: [{ path: result }, { include: "task.txt" }],
          reuse: { from: 0, field: "path" },
        },
      ],
    };
    expect(validateRoute(route, events, "direct").passed).toBe(true);
    const wrongScope = events.map((event) =>
      event.toolCallId === "s" && event.type === "tool_execution_start"
        ? { ...event, args: { path: result, include: "other.txt", query: "marker" } }
        : event,
    );
    const scoped = {
      steps: [{ tool: "search", argsAny: [{ path: "task.txt" }, { include: "task.txt" }] }],
    };
    expect(validateRoute(scoped, wrongScope, "direct").passed).toBe(false);
    const included = events.map((event) =>
      event.toolCallId === "s" && event.type === "tool_execution_start"
        ? { ...event, args: { include: "task.txt", query: "marker" } }
        : event,
    );
    expect(validateRoute(scoped, included, "direct").passed).toBe(true);
    expect(validateRoute(route, included, "direct").passed).toBe(false);
  });
  test("does not accept failed execution or incomplete evidence", () => {
    expect(validateRoute(task, events.slice(0, -1), "direct").passed).toBe(false);
    const failed = events.map((event) =>
      event.toolCallId === "s" && event.type === "tool_execution_end"
        ? { ...event, isError: true }
        : event,
    );
    expect(validateRoute(task, failed, "direct").passed).toBe(false);
  });

  test("distinguishes immediate failures from accepted native text calls", () => {
    const route = { steps: [{ tool: "move", error: "direct" as const }] };
    const direct = [
      { type: "tool_execution_start", toolCallId: "move", toolName: "move", args: {} },
      { type: "tool_execution_end", toolCallId: "move", toolName: "move", isError: true },
    ];
    expect(validateRoute(route, direct, "direct").passed).toBe(true);
    expect(
      validateRoute(
        route,
        direct.map((event) => ({ ...event, isError: false })),
        "direct",
      ).passed,
    ).toBe(false);
    const native = [
      { type: "tool_execution_start", toolCallId: "compose", toolName: "codemode", args: {} },
      ...direct.map((event) => ({ ...event, parentToolCallId: "compose", isError: false })),
      { type: "tool_execution_end", toolCallId: "compose", toolName: "codemode", isError: true },
    ];
    expect(validateRoute(route, native, "codemode").passed).toBe(true);
    expect(
      validateRoute(
        route,
        native.map((event) => (event.toolCallId === "move" ? { ...event, isError: true } : event)),
        "codemode",
      ).passed,
    ).toBe(false);
  });
  test("distinguishes direct calls from real nested Codemode calls", () => {
    expect(validateRoute(task, events, "codemode").passed).toBe(false);
    const nested = events.map((event) => ({ ...event, parentToolCallId: "compose" }));
    const composed = [
      { type: "tool_execution_start", toolCallId: "compose", toolName: "codemode", args: {} },
      ...nested,
      {
        type: "tool_execution_end",
        toolCallId: "compose",
        toolName: "codemode",
        isError: false,
        result: { content: [] },
      },
    ];
    expect(validateRoute(task, composed, "codemode").passed).toBe(true);
  });

  test("allows overlapping independent reads but waits for every reused result", () => {
    const first = events.slice(0, 2);
    const second = first.map((event) => ({ ...event, toolCallId: "r2" }));
    const copy = [
      {
        type: "tool_execution_start",
        toolCallId: "c",
        toolName: "copy",
        args: { path: result, target: result },
      },
      { type: "tool_execution_end", toolCallId: "c", isError: false },
    ];
    const route = {
      steps: [
        { tool: "read" },
        { tool: "read" },
        {
          tool: "copy",
          reuse: [
            { from: 0, field: "path" },
            { from: 1, field: "target" },
          ],
        },
      ],
    };
    const [firstStart, firstEnd] = first;
    const [secondStart, secondEnd] = second;
    const [copyStart, copyEnd] = copy;
    if (!firstStart || !firstEnd || !secondStart || !secondEnd || !copyStart || !copyEnd)
      throw Error("Missing fixture event");
    const overlapping = [firstStart, secondStart, firstEnd, secondEnd, ...copy];
    expect(validateRoute(route, overlapping, "direct").passed).toBe(true);
    expect(
      validateRoute(
        route,
        [firstStart, secondStart, firstEnd, copyStart, secondEnd, copyEnd],
        "direct",
      ).passed,
    ).toBe(false);
    const bypass = overlapping.map((event) =>
      event.toolCallId === "c" && event.type === "tool_execution_start"
        ? { ...event, args: { path: result, target: "task.txt" } }
        : event,
    );
    expect(validateRoute(route, bypass, "direct").passed).toBe(false);
  });
  test("keeps Unicode line separators inside JSON strings", () => {
    expect(parseEvents('{"type":"message_end","text":"a\u2028b"}\n')).toEqual([
      { type: "message_end", text: "a\u2028b" },
    ]);
    expect(() => parseEvents("not json\n")).toThrow(/JSON|Unexpected token/);
  });
});

test("Write receipt capability rejects file text in the tool's own result", () => {
  const route = { steps: [{ tool: "write", contains: "Read the file", excludes: "FILE_BODY" }] };
  const start = { type: "tool_execution_start", toolCallId: "w", toolName: "write", args: {} };
  const end = (text: string) => ({
    type: "tool_execution_end",
    toolCallId: "w",
    isError: false,
    result: { content: [{ type: "text", text }] },
  });
  expect(validateRoute(route, [start, end("Saved file. Read the file")], "direct").passed).toBe(
    true,
  );
  expect(
    validateRoute(route, [start, end("Saved file. Read the file FILE_BODY")], "direct").passed,
  ).toBe(false);
});
test("schema comparison keeps real property names and behavioral defaults", () => {
  expect(
    schemaShape({
      type: "object",
      description: "annotation",
      properties: { title: { type: "string", default: "value", description: "annotation" } },
    }),
  ).toEqual({ properties: { title: { default: "value", type: "string" } }, type: "object" });
});

test("coverage rejects missing cases, uncovered live tools, and duplicate capability IDs", () => {
  const matrix = [{ id: "read.text", cases: ["read-text"] }];
  const cases = [
    {
      id: "read-text",
      capabilities: ["read.text"],
      modes: ["direct", "codemode"],
      steps: [{ tool: "read" }],
    },
  ];
  expect(checkCoverage(matrix, cases, ["read"])).toEqual([]);
  expect(checkCoverage(matrix, [], ["read"]).length).toBeGreaterThan(0);
  expect(checkCoverage(matrix, cases, ["read", "new_tool"]).join(" ")).toContain("new_tool");
  expect(checkCoverage([...matrix, ...matrix], cases, ["read"]).join(" ")).toContain("duplicate");
});

test("deletion capability fixtures preserve symlink identities and detect leftover empty directories", async () => {
  await mkdir(".tmp", { recursive: true });
  const parent = await mkdtemp(path.resolve(".tmp/capability-delete-test-"));
  const source = path.join(parent, "source");
  await mkdir(source);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  try {
    const task = capabilityCases.find(({ id }) => id === "delete-objects");
    if (task === undefined) throw new Error("Missing deletion capability case");
    const trial = await prepareTrial(parent, source, task);
    expect(trial.initial["broken-link"]?.toString()).toBe("symlink:missing");
    expect(trial.initial.link?.toString()).toBe("symlink:sentinel.txt");
    for (const name of [
      "remove-tree/data",
      "remove-tree/link",
      "remove-tree/nested",
      "remove-tree/broken",
      "link",
      "broken-link",
    ])
      await rm(path.join(trial.cwd, name), { recursive: true });
    expect(await validateFiles(trial.cwd, trial.initial, task.expected)).toEqual([
      "Expected deleted object still exists: remove-tree",
    ]);
    await rm(path.join(trial.cwd, "remove-tree"), { recursive: true });
    expect(await validateFiles(trial.cwd, trial.initial, task.expected)).toEqual([]);
    expect(await readFile(path.join(trial.cwd, "sentinel.txt"), "utf8")).toBe("KEEP\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("temporary deletion capability fixtures enforce defaults and replacement without inference", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "capability-temp-delete-"));
  const source = path.join(parent, "source");
  await mkdir(source);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  try {
    for (const id of ["delete-temporary-defaults", "delete-temporary-config"]) {
      const task = capabilityCases.find((entry) => entry.id === id);
      if (task === undefined) throw new Error("Missing temporary deletion case");
      const trial = await prepareTrial(parent, source, task);
      await expect(access(path.join(path.dirname(trial.cwd), ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(path.join(source, ".git"))).resolves.toBeUndefined();
      for (const step of task.steps) {
        const result = await executeFileOperation("delete", step.args, trial.cwd);
        expect(result.ok).toBe(!step.error);
        if (step.error) expect(result.error?.code).toBe("DELETE_CONFIRMATION_REQUIRED");
      }
      expect(await validateFiles(trial.cwd, trial.initial, task.expected)).toEqual([]);
      await cleanupTrial(parent, trial.root);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("directory capability fixtures match actual transfers and refusal effects without inference", async () => {
  await mkdir(".tmp", { recursive: true });
  const parent = await mkdtemp(path.resolve(".tmp/capability-transfer-test-"));
  const source = path.join(parent, "source");
  await mkdir(source);
  execFileSync("git", ["init", "-q", source]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  try {
    for (const id of ["directory-transfers", "directory-transfer-gates"]) {
      const task = capabilityCases.find((entry) => entry.id === id);
      if (task === undefined) throw new Error("Missing transfer capability case");
      const trial = await prepareTrial(parent, source, task);
      for (const step of task.steps) {
        if (step.tool !== "copy" && step.tool !== "move") continue;
        const result = await executeFileOperation(step.tool, step.args, trial.cwd);
        expect(result.ok).toBe(!step.error);
        if (step.error) expect(result.effect).toBe("not-applied");
      }
      expect(await validateFiles(trial.cwd, trial.initial, task.expected)).toEqual([]);
      await cleanupTrial(parent, trial.root);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("a timed-out case cannot touch the checkout and cleanup leaves unrelated files alone", async () => {
  await mkdir(".tmp", { recursive: true });
  const parent = await mkdtemp(path.resolve(".tmp/capability-sandbox-test-"));
  const source = path.join(parent, "source");
  await mkdir(source);
  await writeFile(path.join(source, "tracked.txt"), "source\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
    { cwd: source },
  );
  const sentinel = path.join(parent, "sentinel");
  await writeFile(sentinel, "untouched");
  try {
    const fixture = {
      id: "isolation",
      capabilities: [],
      modes: ["direct"],
      steps: [],
      files: { "task.txt": "clean\n" },
    };
    const first = await prepareTrial(parent, source, fixture);
    const args = await sandboxArgs(source, first.root);
    const run = await runProcess(
      "bwrap",
      [
        ...args,
        "/bin/bash",
        "-c",
        "printf dirty > task.txt; if printf bad > /source/tracked.txt; then exit 91; fi; test ! -e " +
          sentinel +
          "; sleep 10",
      ],
      { timeoutMs: 500 },
    );
    expect(run.timedOut, JSON.stringify(run)).toBe(true);
    await cleanupTrial(parent, first.root);
    await expect(access(first.root)).rejects.toThrow(/ENOENT/);
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect(await readFile(path.join(source, "tracked.txt"), "utf8")).toBe("source\n");
    const next = await prepareTrial(parent, source, fixture);
    expect(await readFile(path.join(next.cwd, "task.txt"), "utf8")).toBe("clean\n");
    await cleanupTrial(parent, next.root);
    const cancelled = await prepareTrial(parent, source, fixture);
    const controller = new AbortController();
    controller.abort();
    const stopped = await runProcess(
      "bwrap",
      [...(await sandboxArgs(source, cancelled.root)), "/bin/bash", "-c", "sleep 10"],
      { signal: controller.signal },
    );
    expect(stopped.code).not.toBe(0);
    expect(stopped.timedOut).toBe(false);
    await cleanupTrial(parent, cancelled.root);
    await expect(
      prepareTrial(parent, source, { ...fixture, files: { [sentinel]: "bad" } }),
    ).rejects.toThrow("Fixture path leaves its case");
    expect((await readdir(parent)).sort()).toEqual(["sentinel", "source"]);
    await expect(cleanupTrial(parent, source)).rejects.toThrow(
      "Cleanup target is not a case-owned trial",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
