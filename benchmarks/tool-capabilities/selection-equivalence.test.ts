import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type CapabilityCase, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
}
const id = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
const matchId = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
function events(calls: Call[], mode: string): RunEvent[] {
  const entries: RunEvent[] = calls.flatMap((call, index) => [
    {
      type: "tool_execution_start",
      toolCallId: String(index),
      toolName: call.tool,
      args: call.args,
      ...(mode === "codemode" && { parentToolCallId: "script" }),
    },
    {
      type: "tool_execution_end",
      toolCallId: String(index),
      toolName: call.tool,
      isError: call.error ?? false,
      result: { content: [{ type: "text", text: call.text ?? "" }], structuredContent: call.value },
    },
  ]);
  return mode === "direct"
    ? entries
    : [
        { type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: {} },
        ...entries,
        { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", isError: false },
      ];
}
function passed(files: Record<string, string>, steps: RouteStep[], calls: Call[], mode: string) {
  return validateRoute({ files, steps }, events(calls, mode), mode).passed;
}
function search(path: string, text: string, lineText = text, line = 1): Call {
  return {
    tool: "search",
    args: { path, query: text },
    text: "SEARCH#ABCD:all:match SEARCH#ABCD:1:match SEARCH#ABCD:1:line",
    value: { id, complete: true, matches: [{ id: matchId, path, line, text, lineText }] },
  };
}
for (const mode of ["direct", "codemode"]) {
  void test(`displayed anchors keep issued provenance and one optional separator in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "replace",
        args: { path: "task.txt", start: /^[0-9A-HJKMNP-TV-Z]{7}$/u, text: "NEW" },
        reuse: { from: 0, field: "start", kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|OLD\r\n",
      value: { id },
    };
    for (const anchor of ["123ABCD", "123ABCD|OLD", "123ABCD|OLD\r\n", "123ABCD|OLD\n"]) {
      const edit: Call = {
        tool: "replace",
        args: { path: "task.txt", start: anchor, text: "NEW" },
      };
      assert.ok(passed({ "task.txt": "OLD\r\n" }, route, [read, edit], mode), anchor);
      assert.ok(!passed({ "task.txt": "OLD\r\n" }, route, [{ ...read, error: true }, edit], mode));
    }
    for (const anchor of ["123ABCD|OTHER", "123ABCD|OLD\n\n", "765ABCD|OLD"]) {
      assert.ok(
        !passed(
          { "task.txt": "OLD\r\n" },
          route,
          [read, { tool: "replace", args: { path: "task.txt", start: anchor, text: "NEW" } }],
          mode,
        ),
      );
    }
  });
  void test(`file plus issued selector stands for a selector path, not another file, in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "search" },
      {
        tool: "insert",
        args: { path: /^SEARCH#[A-F0-9]+:1:line$/u, before: true, text: "ADDED" },
        reuse: { from: 0, field: "path" },
      },
    ];
    for (const field of ["anchor", "start"]) {
      const insert: Call = {
        tool: "insert",
        args: { path: "task.txt", [field]: "SEARCH#ABCD:1:line", before: true, text: "ADDED" },
      };
      assert.ok(passed({ "task.txt": "OLD\n" }, route, [search("task.txt", "OLD"), insert], mode));
      for (const change of [
        { path: "other.txt" },
        { [field]: "SEARCH#FFFF:1:line" },
        { [field]: "SEARCH#ABCD:1:match" },
      ])
        assert.ok(
          !passed(
            { "task.txt": "OLD\n" },
            route,
            [search("task.txt", "OLD"), { ...insert, args: { ...insert.args, ...change } }],
            mode,
          ),
        );
      assert.ok(
        !passed(
          { "task.txt": "OLD\n" },
          route,
          [{ ...search("task.txt", "OLD"), error: true }, insert],
          mode,
        ),
      );
    }
  });
  void test(`Copy exact endpoints and whole lines accept only equal issued spans in ${mode}`, () => {
    const files = {
      "source.txt": "prefix BEGIN body END suffix\n",
      "whole.txt": "before\r\n段🙂\r\nafter\r\n",
      "target.txt": "ANCHOR\nAFTER\n",
    };
    const calls: Call[] = [
      search("source.txt", "BEGIN", files["source.txt"].trim()),
      {
        ...search("source.txt", "END", files["source.txt"].trim()),
        text: "SEARCH#EF01:1:match",
        value: {
          id: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333",
          complete: true,
          matches: [
            {
              path: "source.txt",
              line: 1,
              text: "END",
              lineText: files["source.txt"].trim(),
              id: "RESULT#44444444-aaaa-4aaa-8aaa-444444444444",
            },
          ],
        },
      },
      {
        tool: "copy",
        args: {
          path: "source.txt",
          start: "SEARCH#ABCD:1:match",
          end: "SEARCH#EF01:1:match",
          target: "target.txt",
        },
      },
    ];
    const route: RouteStep[] = [
      { tool: "search" },
      { tool: "search" },
      {
        tool: "copy",
        args: { path: "source.txt", start: "BEGIN", end: "END", target: "target.txt" },
      },
    ];
    assert.ok(passed(files, route, calls, mode));
    const copy = calls[2];
    assert.ok(copy);
    for (const change of [
      { start: "SEARCH#ABCD:1:line" },
      { start: "SEARCH#FFFF:1:match" },
      { path: "whole.txt" },
      { end: "SEARCH#ABCD:1:match" },
    ])
      assert.ok(
        !passed(
          files,
          route,
          [...calls.slice(0, 2), { ...copy, args: { ...copy.args, ...change } }],
          mode,
        ),
      );
    const read: Call = {
      tool: "read",
      args: { path: "whole.txt", views: ["anchors"] },
      text: "123ABCD|段🙂\r\n",
      value: { id },
    };
    const target: Call = {
      tool: "read",
      args: { path: "target.txt", views: ["anchors"] },
      text: "765ABCD|ANCHOR\n",
    };
    const lineRoute: RouteStep[] = [
      { tool: "read" },
      { tool: "read" },
      {
        tool: "copy",
        args: {
          path: "whole.txt",
          start: "段🙂",
          target: "target.txt",
          targetStart: "ANCHOR",
          targetEnd: undefined,
        },
      },
    ];
    for (const selector of ["123ABCD|段🙂\r\n", "SEARCH#ABCD:1:line"]) {
      const issuer = selector.startsWith("SEARCH") ? search("whole.txt", "段🙂", "段🙂", 2) : read;
      const currentRoute = [{ tool: issuer.tool }, ...lineRoute.slice(1)];
      assert.ok(
        passed(
          files,
          currentRoute,
          [
            issuer,
            target,
            {
              tool: "copy",
              args: {
                path: "whole.txt",
                start: selector,
                target: "target.txt",
                targetStart: "765ABCD|ANCHOR\n",
              },
            },
          ],
          mode,
        ),
      );
    }
  });
  void test(`a one-line Read result can select exactly the final line in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "read", args: { path: "line.txt", views: ["anchors"] } },
      {
        tool: "delete",
        args: { path: "line.txt", start: "Last" },
        reuse: { from: 0, field: ["path", "start"], kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "line.txt", offset: 2, limit: 1, views: ["anchors"] },
      text: "123ABCD|Last\r\n",
      value: { id },
    };
    const remove: Call = { tool: "delete", args: { path: { id } } };
    assert.ok(passed({ "line.txt": "First\r\nLast\r\n" }, route, [read, remove], mode));
    for (const change of [
      { offset: 1 },
      { offset: 1, limit: 2 },
      { path: "wrong.txt" },
      { views: ["anchors", "ast"] },
    ])
      assert.ok(
        !passed(
          { "line.txt": "First\r\nLast\r\n" },
          route,
          [{ ...read, args: { ...read.args, ...change } }, remove],
          mode,
        ),
      );
    assert.ok(
      !passed(
        { "line.txt": "First\r\nLast\r\n" },
        route,
        [read, { ...remove, args: { path: { id: matchId } } }],
        mode,
      ),
    );
  });
  void test(`selection evidence cannot outlive a mutation or replace a required issuer in ${mode}`, () => {
    const files = { "task.txt": "OLD\nLast\n" };
    const route: RouteStep[] = [
      { tool: "read" },
      {
        tool: "copy",
        args: { path: "task.txt", start: "Last", target: "target.txt" },
        reuse: { from: 0, field: "start", kind: "anchor" },
      },
    ];
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|Last\n",
      value: { id },
    };
    const copy: Call = {
      tool: "copy",
      args: { path: "task.txt", start: "123ABCD|Last\n", target: "target.txt" },
    };
    assert.ok(passed(files, route, [read, copy], mode));
    assert.ok(!passed(files, route, [copy], mode));
    const edit: Call = {
      tool: "replace",
      args: { path: "task.txt", start: "Last", text: "Changed" },
    };
    assert.ok(!passed(files, route, [read, edit, copy], mode));
    assert.ok(
      !passed(
        files,
        route,
        [{ ...read, args: { path: "wrong.txt", views: ["anchors"] } }, copy],
        mode,
      ),
    );
    // Copy is read-only on its source: a second destination does not stale that evidence.
    const first: Call = { tool: "copy", args: { ...copy.args, target: "first.txt" } };
    assert.ok(passed(files, route, [read, first, copy], mode));
  });
  void test(`whole-result reuse accepts a complete single match but not part of a larger Search in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "search" },
      {
        tool: "replace",
        args: { text: "NEW" },
        reuse: { from: 0, field: ["path", "start"], kind: "whole-result" },
      },
    ];
    const found = search("task.txt", "OLD");
    const replace: Call = {
      tool: "replace",
      args: { path: "task.txt", start: "SEARCH#ABCD:1:match", text: "NEW" },
    };
    assert.ok(passed({ "task.txt": "OLD\n" }, route, [found, replace], mode));
    for (const value of [
      { id, complete: false, matches: [{ id: matchId }] },
      { id, complete: true, matches: [{ id: matchId }, { id: "other" }] },
    ])
      assert.ok(!passed({ "task.txt": "OLD\n" }, route, [{ ...found, value }, replace], mode));
  });
  void test(`debug source Read accepts the launched program's path only in ${mode}`, () => {
    const route: RouteStep[] = [
      { tool: "debug", args: { program: "task.py" } },
      {
        tool: "read",
        args: { path: /^debug:[a-z0-9-]+\/source$/u, views: ["anchors"] },
        after: [0],
      },
    ];
    const launch: Call = { tool: "debug", args: { program: "task.py" }, text: "debug:session-1" };
    const read: Call = { tool: "read", args: { path: "task.py", views: ["anchors"] } };
    assert.ok(passed({ "task.py": "print(1)\n" }, route, [launch, read], mode));
    assert.ok(
      !passed(
        { "task.py": "print(1)\n" },
        route,
        [launch, { ...read, args: { ...read.args, path: "other.py" } }],
        mode,
      ),
    );
    assert.ok(
      !passed({ "task.py": "print(1)\n" }, route, [{ ...launch, error: true }, read], mode),
    );
  });
  void test(`stale recovery's fresh Read and rejected old Read are independent in ${mode}`, () => {
    const task = capabilityCases.find((entry) => entry.id === "stale-recovery") as CapabilityCase;
    const read: Call = {
      tool: "read",
      args: { path: "task.txt", views: ["anchors"] },
      text: "123ABCD|OLD\n",
      value: { id },
    };
    const edit: Call = { tool: "replace", args: { path: "task.txt", start: "OLD", text: "NEW" } };
    const old: Call = { tool: "read", args: { path: { id } }, error: true };
    const fresh: Call = { tool: "read", args: { path: "task.txt" }, text: "NEW" };
    assert.ok(validateRoute(task, events([read, edit, fresh, old], mode), mode).passed);
    assert.ok(!validateRoute(task, events([read, fresh, edit, old], mode), mode).passed);
  });
}
