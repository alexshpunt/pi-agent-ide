import { strict as assert } from "node:assert";
import test from "node:test";
import { capabilityCases } from "./cases.ts";
import { validateRoute, type RouteStep, type RunEvent } from "./validation.ts";

interface Call {
  tool: string;
  args: Record<string, unknown>;
  text?: string;
  value?: unknown;
  error?: boolean;
}
const result = "RESULT#11111111-aaaa-4aaa-8aaa-111111111111";
function events(calls: Call[], mode = "direct"): RunEvent[] {
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
function task(id: string) {
  const found = capabilityCases.find((entry) => entry.id === id);
  assert.ok(found);
  return found;
}
function passes(id: string, calls: Call[], mode = "direct") {
  return validateRoute(task(id), events(calls, mode), mode).passed;
}

for (const mode of ["direct", "codemode"]) {
  void test(`${mode}: Pi-coerced numeric arguments match without mutating evidence or structured results`, () => {
    const readStep: RouteStep = { tool: "read", args: { path: "task.txt", offset: 2, limit: 1 } };
    const route = [readStep];
    const retained = events(
      [{ tool: "read", args: { path: "/workspace/fixture/task.txt", offset: "2", limit: "1" } }],
      mode,
    );
    const original = structuredClone(retained);
    assert.ok(validateRoute({ steps: route }, retained, mode).passed);
    assert.deepEqual(retained, original);
    const catalogCalls: Call[] = [
      { tool: "read", args: { path: "docs:ide-settings", limit: "1000" }, text: "ui.codemode" },
      ...["docs:ide-settings", "docs:all"].map((path) => ({
        tool: "search",
        args: { path, query: "ui.codemode", caseSensitive: true, limit: "1000" },
        text: "docs:ide-settings:1",
      })),
    ];
    assert.ok(passes("ide-settings-catalog", catalogCalls, mode));
    assert.equal(
      passes(
        "ide-settings-catalog",
        catalogCalls.map((call) => ({ ...call, args: { ...call.args, limit: "999" } })),
        mode,
      ),
      false,
    );
    for (const offset of ["two", "2x", "3", "2.5", "0"]) {
      assert.equal(
        validateRoute(
          { steps: route },
          events([{ tool: "read", args: { path: "task.txt", offset, limit: "1" } }], mode),
          mode,
        ).passed,
        false,
      );
    }
    const strict: RouteStep[] = [{ tool: "read", scriptResult: { count: 2 } }];
    assert.equal(
      validateRoute(
        { steps: strict },
        events([{ tool: "read", args: { path: "task.txt" }, value: { count: "2" } }], mode),
        mode,
      ).passed,
      false,
    );
    const windowRoute: RouteStep[] = [
      readStep,
      {
        tool: "replace",
        args: { path: "task.txt", start: "OLD", text: "NEW" },
        reuse: { from: 0, field: ["path", "start"] },
      },
    ];
    assert.ok(
      validateRoute(
        { files: { "task.txt": "keep\nOLD\nlast\n" }, steps: windowRoute },
        events(
          [
            {
              tool: "read",
              args: { path: "task.txt", offset: "2", limit: "1" },
              value: { id: result },
            },
            { tool: "replace", args: { path: result, text: "NEW\n" } },
          ],
          mode,
        ),
        mode,
      ).passed,
    );
  });

  void test(`${mode}: read-jq explicit paths can overlap or execute in either order`, () => {
    const calls: [Call, Call] = [
      {
        tool: "read",
        args: { path: "config.json", views: ["jq:.status"] },
        text: `ready ${result}`,
      },
      {
        tool: "read",
        args: {
          path: "/workspace/fixture/config.json",
          views: ["jq:.status, .untouched"],
          offset: 2,
          limit: 1,
        },
        text: "7",
      },
    ];
    const sequential = events(calls, mode);
    const prefix = mode === "codemode" ? sequential.slice(0, 1) : [];
    const suffix = mode === "codemode" ? sequential.slice(-1) : [];
    const [start0, end0, start1, end1] = mode === "codemode" ? sequential.slice(1, -1) : sequential;
    assert.ok(start0 && end0 && start1 && end1);
    for (const middle of [
      [start0, start1, end0, end1],
      [start1, end1, start0, end0],
    ]) {
      assert.ok(validateRoute(task("read-jq"), [...prefix, ...middle, ...suffix], mode).passed);
      assert.equal(
        validateRoute(
          task("read-jq"),
          [...prefix, ...middle.filter((event) => event.toolCallId !== "0"), ...suffix],
          mode,
        ).passed,
        false,
      );
    }
    for (const path of ["other.json", "RESULT#22222222-aaaa-4aaa-8aaa-222222222222"]) {
      assert.equal(
        passes("read-jq", [calls[0], { ...calls[1], args: { ...calls[1].args, path } }], mode),
        false,
      );
    }
    const referenceStart = { ...start1, args: { ...start1.args, path: result } };
    assert.equal(
      validateRoute(
        task("read-jq"),
        [...prefix, start0, referenceStart, end0, end1, ...suffix],
        mode,
      ).passed,
      false,
    );
    assert.ok(
      validateRoute(
        task("read-jq"),
        [...prefix, start0, end0, referenceStart, end1, ...suffix],
        mode,
      ).passed,
    );
  });

  void test(`${mode}: explicit sources retain issuer slots and parent separation`, () => {
    const calls: Call[] = [{ tool: "read", args: { path: "config.json" } }];
    for (const from of [-1, 0, 1]) {
      assert.equal(
        validateRoute(
          {
            steps: [
              {
                tool: "read",
                reuse: { from, field: "path", explicit: "config.json" },
              },
            ],
          },
          events(calls, mode),
          mode,
        ).passed,
        false,
      );
    }
    if (mode === "codemode") {
      assert.equal(
        validateRoute(
          {
            steps: [
              { tool: "tool_search", discovers: ["read"] },
              { tool: "read", reuse: { from: 0, field: "path", explicit: "config.json" } },
            ],
          },
          events(calls, mode),
          mode,
        ).passed,
        false,
      );
      assert.equal(
        validateRoute(
          {
            steps: [
              { tool: "read" },
              {
                tool: "read",
                reuse: { from: 0, field: "path", explicit: "config.json", newParent: true },
              },
            ],
          },
          events([...calls, ...calls], mode),
          mode,
        ).passed,
        false,
      );
    }
  });
  for (const tool of ["insert", "replace", "delete", "copy", "move"]) {
    void test(`${mode}: fresh Search fragments remain provable after a prior edit for ${tool}`, () => {
      const fragment = "α\r\nβ";
      const match = "RESULT#22222222-aaaa-4aaa-8aaa-222222222222";
      const selector = tool === "insert" ? "anchor" : "start";
      const extra =
        tool === "insert"
          ? { text: "]", before: false }
          : tool === "replace"
            ? { text: "NEW" }
            : ["copy", "move"].includes(tool)
              ? { target: "target.txt" }
              : {};
      const opening: Call = {
        tool: "insert",
        args: { path: "task.txt", anchor: "α", text: "[", before: true },
      };
      const found: Call = {
        tool: "search",
        args: { path: "task.txt", query: "regex:α\\r?\\nβ", multiline: true },
        text: "SEARCH#ABCD:1:match SEARCH#ABCD:1:line",
        value: {
          id: result,
          complete: true,
          matches: [
            {
              id: match,
              path: "task.txt",
              line: 2,
              text: fragment,
              lineText: "left [α\r\nβ right",
            },
          ],
        },
      };
      const closing: Call = {
        tool,
        args: { path: "task.txt", [selector]: { id: match }, ...extra },
      };
      const route: RouteStep[] = [
        { tool: "insert", args: opening.args },
        { tool: "search", args: found.args, after: [0] },
        {
          tool,
          args: { path: "task.txt", [selector]: fragment, ...extra },
          reuse: { from: 1, field: ["path", selector] },
          after: [1],
        },
      ];
      const files = { "task.txt": "head\r\nleft α\r\nβ right\r\n" };
      const check = (calls: Call[]) =>
        validateRoute({ files, steps: route }, events(calls, mode), mode).passed;
      for (const reference of [{ id: match }, { id: result }, "SEARCH#ABCD:1:match"]) {
        assert.ok(
          check([opening, found, { ...closing, args: { ...closing.args, [selector]: reference } }]),
        );
      }
      assert.ok(check([opening, found, { ...closing, args: { path: { id: match }, ...extra } }]));
      for (const args of [
        { ...closing.args, path: "other.txt" },
        { ...closing.args, [selector]: "RESULT#33333333-aaaa-4aaa-8aaa-333333333333" },
        { ...closing.args, [selector]: "SEARCH#ABCD:1:line" },
      ])
        assert.equal(check([opening, found, { ...closing, args }]), false);
      for (const selected of [
        { id: match, path: "other.txt", line: 2, text: fragment, lineText: "left [α\r\nβ right" },
        { id: match, path: "task.txt", line: 2, text: "β", lineText: "left [α\r\nβ right" },
        { id: match, path: "task.txt", line: 2, text: fragment, lineText: fragment },
      ]) {
        assert.equal(
          check([
            opening,
            { ...found, value: { id: result, complete: true, matches: [selected] } },
            closing,
          ]),
          false,
        );
      }
      const changed: Call = {
        tool: "insert",
        args: { path: "task.txt", anchor: "head", text: "!", before: true },
      };
      assert.equal(check([opening, found, changed, closing]), false);
      assert.ok(check([opening, found, { ...changed, error: true }, closing]));
      assert.ok(
        check([
          opening,
          found,
          { ...changed, args: { ...changed.args, path: "other.txt" } },
          closing,
        ]),
      );
      const ranged = (startColumn: number, endColumn: number): Call => ({
        ...found,
        value: {
          id: result,
          complete: true,
          matches: [
            {
              id: match,
              path: "task.txt",
              line: 2,
              text: fragment,
              lineText: "left [α\r\nβ right",
              range: { startLine: 2, startColumn, endLine: 3, endColumn },
            },
          ],
        },
      });
      assert.ok(check([opening, ranged(6, 1), closing]));
      assert.equal(check([opening, ranged(5, 1), closing]), false);
      assert.equal(check([opening, ranged(6, 2), closing]), false);
      const concurrent = events([opening, changed, found, closing], mode);
      const prefix = mode === "codemode" ? concurrent.slice(0, 1) : [];
      const suffix = mode === "codemode" ? concurrent.slice(-1) : [];
      const middle = mode === "codemode" ? concurrent.slice(1, -1) : concurrent;
      for (const order of [
        [0, 1, 2, 4, 5, 3, 6, 7],
        [0, 1, 4, 5, 2, 6, 7, 3],
      ]) {
        const reordered = order.map((index) => middle[index]);
        assert.ok(reordered.every((event): event is RunEvent => event !== undefined));
        assert.equal(
          validateRoute({ files, steps: route }, [...prefix, ...reordered, ...suffix], mode).passed,
          false,
        );
      }
      assert.equal(check([opening, { ...found, error: true }, closing]), false);
      assert.equal(check([opening, closing]), false);
      assert.equal(
        check([
          opening,
          {
            ...found,
            value: {
              id: result,
              complete: true,
              matches: [
                {
                  id: match,
                  path: "task.txt",
                  line: 2,
                  text: fragment,
                  lineText: "left [α\r\nβ right",
                },
                {
                  id: "other",
                  path: "task.txt",
                  line: 4,
                  text: fragment,
                  lineText: "left α\r\nβ right",
                },
              ],
            },
          },
          { ...closing, args: { path: { id: result }, ...extra } },
        ]),
        false,
      );
    });
  }
  for (const ending of ["lf", "crlf", "unterminated"]) {
    void test(`${mode}: exact-eof-${ending} reviews the leading-separator selector without widening other boundaries`, () => {
      const eol = ending === "crlf" ? "\r\n" : "\n";
      const calls: [Call, Call, Call, Call, Call] = [
        { tool: "replace", args: { path: "last.txt", start: "Last", text: "Final" } },
        { tool: "delete", args: { path: "block.txt", start: `${eol}Last${eol}Block` } },
        { tool: "replace", args: { path: "empty.txt", start: `${eol}Last${eol}Block`, text: "" } },
        { tool: "read", args: { path: "line.txt", views: ["anchors"] }, text: "ABCDEFG|Last" },
        { tool: "delete", args: { path: "line.txt", start: "ABCDEFG" } },
      ];
      const id = `exact-eof-${ending}`;
      assert.equal(passes(id, calls, mode), ending !== "unterminated");
      for (const start of [
        `${eol}${eol}Last${eol}Block`,
        `First${eol}Last${eol}Block`,
        `${eol}Last${eol}Block${eol}`,
      ]) {
        assert.equal(
          passes(
            id,
            [calls[0], { ...calls[1], args: { ...calls[1].args, start } }, ...calls.slice(2)],
            mode,
          ),
          false,
        );
      }
      for (const field of [{ path: "wrong.txt" }, { end: "Block" }]) {
        assert.equal(
          passes(
            id,
            [calls[0], { ...calls[1], args: { ...calls[1].args, ...field } }, ...calls.slice(2)],
            mode,
          ),
          false,
        );
      }
    });
  }

  void test(`${mode}: insert-before accepts equivalent fragment edges but retains side and issued-reference requirements`, () => {
    const calls: Call[] = [
      {
        tool: "insert",
        args: {
          path: "task.txt",
          anchor: "OLD",
          text: "NOTE",
          before: true,
          separation: "blank-line",
        },
      },
      { tool: "insert", args: { path: "literal.txt", anchor: "α🙂", text: "[", before: true } },
      { tool: "insert", args: { path: "literal.txt", anchor: "α🙂", text: "]" } },
      { tool: "insert", args: { path: "block.txt", anchor: "α", text: "[", before: true } },
      { tool: "insert", args: { path: "block.txt", anchor: "β", text: "]" } },
      { tool: "search", args: { path: "search.txt", query: "MATCH" }, text: "SEARCH#ABCD:1:match" },
      {
        tool: "insert",
        args: { path: "search.txt", anchor: "SEARCH#ABCD:1:match", text: "[", before: true },
      },
      { tool: "search", args: { path: "search.txt", query: "MATCH" }, text: "SEARCH#DCBA:1:match" },
      { tool: "insert", args: { path: "search.txt", anchor: "SEARCH#DCBA:1:match", text: "]" } },
    ];
    assert.ok(passes("insert-before", calls, mode));
    for (const [index, fields] of [
      [3, { anchor: "β" }],
      [4, { anchor: "α" }],
      [3, { before: false }],
      [4, { before: true }],
      [3, { path: "literal.txt" }],
      [4, { text: "[" }],
      [6, { anchor: "SEARCH#FFFF:1:match" }],
      [8, { anchor: "SEARCH#ABCD:1:match" }],
      [6, { anchor: "MATCH" }],
    ] as const) {
      assert.equal(
        passes(
          "insert-before",
          calls.map((call, position) =>
            position === index ? { ...call, args: { ...call.args, ...fields } } : call,
          ),
          mode,
        ),
        false,
      );
    }
    assert.equal(
      passes(
        "insert-before",
        calls.filter((_, index) => index !== 7),
        mode,
      ),
      false,
    );
  });
}
